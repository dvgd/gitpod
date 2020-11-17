/**
 * Copyright (c) 2020 TypeFox GmbH. All rights reserved.
 * Licensed under the GNU Affero General Public License (AGPL).
 * See License-AGPL.txt in the project root for license information.
 */

import { injectable, inject, postConstruct } from 'inversify';
import * as express from "express"
import * as passport from "passport"
import * as OAuth2Strategy from "passport-oauth2";
import { UserDB } from "@gitpod/gitpod-db/lib/user-db";
import { AuthProviderInfo, Identity, Token, User, UserEnvVarValue } from '@gitpod/gitpod-protocol';
import { log, LogContext } from '@gitpod/gitpod-protocol/lib/util/logging';
import fetch from "node-fetch";
import { oauth2tokenCallback, OAuth2 } from 'oauth';
import { format as formatURL, URL } from 'url';
import * as uuidv4 from 'uuid/v4';
import { runInNewContext } from "vm";
import { AuthBag, AuthProvider } from "../auth/auth-provider";
import { AuthProviderParams, AuthUserSetup } from "../auth/auth-provider";
import { AuthException } from "../auth/errors";
import { GitpodCookie } from "../auth/gitpod-cookie";
import { Env } from "../env";
import { getRequestingClientInfo } from "../express-util";
import { TokenProvider } from '../user/token-provider';
import { UserService } from "../user/user-service";
import { AuthProviderService } from './auth-provider-service';
import { AuthErrorHandler } from './auth-error-handler';

/**
 * This is a generic implementation of OAuth2-based AuthProvider.
 * --
 * The main entrypoints go along the phases of the OAuth2 Authorization Code Flow:  
 * 
 * 1. `authorize` – this is called by the `Authenticator` to handle login/authorization requests.
 * 
 *   The OAuth2 library under the hood will redirect send a redirect response to initialize the OAuth2 flow with the 
 *   authorization service.
 * 
 *   The continuation of the flow is an expected incoming request on the callback path. Between those two phases the 
 *   AuthProvider needs to persist an intermediate state in order to preserve the original parameters.
 * 
 * 2. `callback` – the `Authenticator` handles requests matching the `/auth/*` paths and delegates to the responsible AuthProvider.
 *  
 *   The complex operation combines the token exchanges (which happens under the hood) with unverified authentication of
 *   the user.
 * 
 *   Once `access_token` is provided, the `readAuthUserSetup` is executed to query the specific auth server APIs and 
 *   obtain the information needed to create new users or identify existing users. 
 * 
 * 3. `refreshToken` – the `TokenService` may call this if the token aquired by this AuthProvider.
 * 
 *   The AuthProvider requests to renew an `access_token` if supported, i.e. a `refresh_token` is provided in the original
 *   token response.
 *  
 */
@injectable()
export class GenericAuthProvider implements AuthProvider {

    @inject(AuthProviderParams) config: AuthProviderParams;
    @inject(TokenProvider) protected readonly tokenProvider: TokenProvider;
    @inject(UserDB) protected userDb: UserDB;
    @inject(Env) protected env: Env;
    @inject(GitpodCookie) protected gitpodCookie: GitpodCookie;
    @inject(UserService) protected readonly userService: UserService;
    @inject(AuthProviderService) protected readonly authProviderService: AuthProviderService;
    @inject(AuthErrorHandler) protected readonly authErrorHandler: AuthErrorHandler;

    protected strategy: GenericOAuth2Strategy;

    @postConstruct()
    init() {
        this.strategy = new GenericOAuth2Strategy(this.strategyName, { ...this.defaultStrategyOptions }, this.verify.bind(this));
        this.initAuthUserSetup();
        log.info(`(${this.strategyName}) Initialized.`, { defaultStrategyOptions: this.defaultStrategyOptions });
    }

    get info(): AuthProviderInfo {
        return this.defaultInfo();
    }

    protected defaultInfo(): AuthProviderInfo {
        const scopes = this.oauthScopes;
        const { id, type, icon, host, ownerId, verified, hiddenOnDashboard, disallowLogin, description, loginContextMatcher } = this.config;
        return {
            authProviderId: id,
            authProviderType: type,
            ownerId,
            verified,
            host,
            icon,
            hiddenOnDashboard,
            loginContextMatcher,
            disallowLogin,
            description,
            scopes,
            settingsUrl: this.oauthConfig.settingsUrl,
            requirements: {
                default: scopes,
                publicRepo: scopes,
                privateRepo: scopes
            }
        }
    }

    protected get USER_AGENT() {
        return new URL(this.oauthConfig.callBackUrl).hostname;
    }

    protected get strategyName() {
        return `Auth-With-${this.host}`;
    }
    get host() {
        return this.config.host;
    }
    get authProviderId() {
        return this.config.id;
    }
    protected get oauthConfig() {
        return this.config.oauth!;
    }
    protected get oauthScopes() {
        if (!this.oauthConfig.scope) {
            return [];
        }
        const scopes = this.oauthConfig.scope.split(this.oauthConfig.scopeSeparator || " ").map(s => s.trim()).filter(s => !!s);
        return scopes;
    }

    protected readAuthUserSetup?: (accessToken: string, tokenResponse: object) => Promise<AuthUserSetup>;

    authorize(req: express.Request, res: express.Response, next: express.NextFunction, scope?: string[]): void {
        const handler = passport.authenticate(this.strategy as any, { ...this.defaultStrategyOptions, ...{ scope } });
        handler(req, res, next);
    }

    async refreshToken(user: User) {
        log.info(`(${this.strategyName}) Token to be refreshed.`, { userId: user.id });
        const { authProviderId } = this;
        const identity = User.getIdentity(user, authProviderId);
        if (!identity) {
            throw new Error(`Cannot find an identity for ${authProviderId}`);
        }
        const token = await this.userDb.findTokenForIdentity(identity);
        if (!token) {
            throw new Error(`Cannot find any current token for ${authProviderId}`);
        }
        const { refreshToken, expiryDate } = token;
        if (!refreshToken || !expiryDate) {
            throw new Error(`Cannot refresh token for ${authProviderId}`);
        }
        try {
            const refreshResult = await new Promise<{ access_token: string, refresh_token: string, result: any }>((resolve, reject) => {
                this.strategy.requestNewAccessToken(refreshToken, {}, (error, access_token, refresh_token, result) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve({ access_token, refresh_token, result });
                });
            });
            const { access_token, refresh_token, result } = refreshResult;

            // update token
            const now = new Date();
            const updateDate = now.toISOString();
            const tokenExpiresInSeconds = typeof result.expires_in === "number" ? result.expires_in : undefined;
            const expiryDate = tokenExpiresInSeconds ? new Date(now.getTime() + tokenExpiresInSeconds * 1000).toISOString() : undefined;
            const newToken: Token = {
                value: access_token,
                scopes: token.scopes,
                updateDate,
                expiryDate,
                refreshToken: refresh_token
            };
            await this.userDb.storeSingleToken(identity, newToken);
            log.info(`(${this.strategyName}) Token refreshed and updated.`, { userId: user.id, updateDate, expiryDate });
        } catch (error) {
            log.error(`(${this.strategyName}) Failed to refresh token!`, { error, token });
            throw error;
        }
    }

    protected initAuthUserSetup() {
        if (this.readAuthUserSetup) {
            // it's defined in subclass
            return;
        }
        const { configFn, configURL } = this.oauthConfig;
        if (configURL) {
            this.readAuthUserSetup = async (accessToken: string, tokenResponse: object) => {
                try {
                    const fetchResult = await fetch(configURL, {
                        method: "POST",
                        headers: {
                            "Accept": "application/json",
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                            accessToken,
                            tokenResponse
                        })
                    });
                    if (fetchResult.ok) {
                        const jsonResult = await fetchResult.json();
                        return jsonResult as AuthUserSetup;
                    } else {
                        throw new Error(fetchResult.statusText);
                    }
                } catch (error) {
                    log.error(`(${this.strategyName}) Failed to fetch from "configURL"`, { error, configURL, accessToken });
                    throw new Error("Error while reading user profile.");
                }
            }
            return;
        }
        if (configFn) {
            this.readAuthUserSetup = async (accessToken: string, tokenResponse: object) => {
                let promise: Promise<AuthUserSetup>;
                try {
                    promise = runInNewContext(`tokenResponse = ${JSON.stringify(tokenResponse)} || {}; (${configFn})("${accessToken}", tokenResponse)`,
                        { fetch, console },
                        { filename: `${this.strategyName}-fetchAuthUser`, timeout: 5000 });
                } catch (error) {
                    log.error(`(${this.strategyName}) Failed to call "fetchAuthUserSetup"`, { error, configFn, accessToken });
                    throw new Error("Error with the Auth Provider Configuration.");
                }
                try {
                    return await promise;
                } catch (error) {
                    log.error(`(${this.strategyName}) Failed to run "configFn"`, { error, configFn, accessToken });
                    throw new Error("Error while reading user profile.");
                }
            }
        }
    }

    get authCallbackPath() {
        return new URL(this.oauthConfig.callBackUrl).pathname;
    }

    /**
     * Once the auth service and the user agreed to continue with the OAuth2 flow, this callback function
     * initializes the continuation of the auth process:
     * 
     * - (1) `passport.authenticate` is called to handle the token exchange; once done, the following happens...
     * - (2) the so called "verify" function is called by passport, which is expected to find/create/update 
     *   user instances after requesting user information from the auth service.
     * - (3) the result of the "verify" function is first handled by passport internally and then passed to the
     *   callback from the `passport.authenticate` call (1) 
     */
    readonly callback: express.RequestHandler = (request, response, next) => {
        const authProviderId = this.authProviderId;
        const strategyName = this.strategyName;
        const clientInfo = getRequestingClientInfo(request);
        if (response.headersSent) {
            log.warn(`(${strategyName}) Callback called repeatedly.`, { request, clientInfo });
            return;
        }
        log.info(`(${strategyName}) OAuth2 callback call. `, { clientInfo, authProviderId, requestUrl: request.originalUrl });

        const isAlreadyLoggedIn = request.isAuthenticated() && User.is(request.user);
        const authBag = AuthBag.get(request.session);
        if (isAlreadyLoggedIn) {
            if (!authBag || authBag.requestType === "authenticate") {
                log.warn({}, `(${strategyName}) User is already logged in. No auth info provided. Redirecting to dashboard.`, { request, clientInfo });
                response.redirect(this.env.hostUrl.asDashboard().toString());
                return;
            }
        }

        // assert additional infomation is attached to current session
        if (!authBag) {
            log.error({}, `(${strategyName}) No session found during auth callback.`, { request, clientInfo });
            response.redirect(this.getSorryUrl(`Please allow Cookies in your browser and try to log in again.`));
            return;
        }

        const defaultLogPayload = { authBag, clientInfo, authProviderId };

        // check OAuth2 errors
        const error = new URL(formatURL({ protocol: request.protocol, host: request.get('host'), pathname: request.originalUrl })).searchParams.get("error");
        if (error) { // e.g. "access_denied"
            log.info(`(${strategyName}) Received OAuth2 error, thus redirecting to /sorry (${error})`, { ...defaultLogPayload, requestUrl: request.originalUrl });
            response.redirect(this.getSorryUrl(`OAuth2 error. (${error})`));
            return;
        }

        const passportAuthHandler = passport.authenticate(this.strategy as any, async (...[err, user, info]: Parameters<OAuth2Strategy.VerifyCallback>) => {
            /*
             * (3) this callback function is called after the "verify" function as the final step in the authentication process in passport.
             * 
             * - the `err` parameter may include any error raised from the "verify" function call.
             * - the `user` parameter may include the accepted user instance.
             * - the `info` parameter may include additional info to the process.
             * 
             * given that everything relevant to the state is already processed, this callback is supposed to finally handle the
             * incoming `/callback` request:
             * 
             * - redirect to handle/display errors
             * - redirect to terms acceptance request page
             * - call `request.login` on new sessions
             * - redirect to `returnTo` (from request parameter)
             */

            if (authBag.requestType === 'authenticate') {
                await this.loginCallbackHandler(authBag, request, response, defaultLogPayload, err, user, info);
            } else {
                await this.authorizeCallbackHandler(authBag, request, response, defaultLogPayload, err, user, info);
            }
        });
        passportAuthHandler(request, response, next);
    }
    protected async authorizeCallbackHandler(authBag: AuthBag, request: express.Request, response: express.Response, logPayload: object, ...[err, user, info]: Parameters<OAuth2Strategy.VerifyCallback>) {
        const { id, verified, ownerId } = this.config;
        const strategyName = this.strategyName;
        const context: LogContext = User.is(user) ? { userId: user.id } : {};
        log.info(context, `(${strategyName}) Callback (authorize)`, { ...logPayload });
        if (err || !User.is(user)) {
            const message = this.isOAuthError(err) ?
                'OAuth Error. Please try again.' : // this is a 5xx responsefrom
                'Authorization failed. Please try again.'; // this might be a race of our API calls
            log.error(context, `(${strategyName}) Redirect to /sorry from authorizeCallbackHandler`, { ...logPayload, err });
            response.redirect(this.getSorryUrl(message));
            return;
        }
        if (!verified && User.is(user) && user.id === ownerId) {
            try {
                await this.authProviderService.markAsVerified({ id, ownerId });
            } catch (error) {
                log.error(context, `(${strategyName}) Redirect to /sorry (OAuth Error)`, { ...logPayload, err });
            }
        }
        response.redirect(authBag.returnTo);
    }
    protected async loginCallbackHandler(authBag: AuthBag, request: express.Request, response: express.Response, logPayload: object, ...[err, user, info]: Parameters<OAuth2Strategy.VerifyCallback>) {
        const { id, verified, ownerId } = this.config;
        const strategyName = this.strategyName;
        const context: LogContext = User.is(user) ? { userId: user.id } : {};
        log.info(context, `(${strategyName}) Callback (login)`, { ...logPayload });

        const handledError = await this.authErrorHandler.check(err);
        if (handledError) {
            if (request.session) {
                await AuthBag.attach(request.session, { ...authBag, ...handledError});
            }
            const { redirectToUrl } = handledError;
            log.info(context, `(${strategyName}) Handled auth error. Redirecting to ${redirectToUrl}`, { ...logPayload, err });
            response.redirect(redirectToUrl);
            return;
        }
        if (err) {
            let message = 'Authorization failed. Please try again.';
            if (AuthException.is(err)) {
                message = `Login was interrupted: ${err.message}`;
            }
            if (this.isOAuthError(err)) {
                message = 'OAuth Error. Please try again.'; // this is a 5xx response from authorization service
            }
            log.error(context, `(${strategyName}) Redirect to /sorry from loginCallbackHandler`, err, { ...logPayload, err });
            response.redirect(this.getSorryUrl(message));
            return;
        }
        if (!User.is(user)) {
            log.error(context, `(${strategyName}) Redirect to /sorry (NO user)`, { request, ...logPayload });
            response.redirect(this.getSorryUrl('Login with failed.'));
            return;
        }

        const userCount = await this.userDb.getUserCount();
        if (User.is(user) && userCount === 1) {
            // assuming the single user was just created, we can mark the user as admin
            user.rolesOrPermissions = ['admin'];
            user = await this.userDb.storeUser(user);

            // we can now enable the first auth provider
            if (this.config.builtin === false && !verified && User.is(user)) {
                this.authProviderService.markAsVerified({ id, ownerId, newOwnerId: user.id });
            }
        }

        // Finally login and redirect.
        request.login(user, err => {
            if (err) {
                throw err;
            }
            // re-read the session info, as it might have changed in the authenticator
            const authBag = AuthBag.get(request.session);
            if (!authBag || authBag.requestType !== 'authenticate') {
                response.redirect(this.getSorryUrl('Session not found.'));
                return;
            }
            let returnTo = authBag.returnTo;
            const context: LogContext = User.is(user) ? { userId: user.id } : {};
            if (authBag.elevateScopes) {
                const elevateScopesUrl = this.env.hostUrl.withApi({
                    pathname: '/authorize',
                    search: `returnTo=${encodeURIComponent(returnTo)}&host=${authBag.host}&scopes=${authBag.elevateScopes.join(',')}`
                }).toString();
                returnTo = elevateScopesUrl;
            }
            log.info(context, `(${strategyName}) User is logged in successfully. Redirect to: ${returnTo}`, { ...logPayload });

            // Clean up the session
            AuthBag.clear(request.session);

            // Create Gitpod 🍪 before the redirect
            this.gitpodCookie.setCookie(response);
            response.redirect(returnTo);
        });
    }

    /**
     * cf. (2) of `callback` function (a.k.a. `/callback` handler)
     * 
     * - `access_token` is provided
     * - it's expected to fetch the user info (see `fetchAuthUserSetup`)
     * - it's expected to handle the state persisted in the database in order to find/create/update the user instance
     * - it's expected to identify missing requirements, e.g. missing terms acceptance
     * - finally, it's expected to call `done` and provide the computed result in order to finalize the auth process
     */
    protected async verify(req: express.Request, accessToken: string, refreshToken: string | undefined, tokenResponse: any, _profile: undefined, done: OAuth2Strategy.VerifyCallback) {
        interface AdditionalVerifyResult {
            termsAcceptanceRequired?: boolean;
            elevateScopes?: string[];
            isBlocked?: boolean;
        }
        const hints: AdditionalVerifyResult = {};
        const { strategyName, config } = this;
        const clientInfo = getRequestingClientInfo(req);
        const authProviderId = this.authProviderId;
        const authBag = AuthBag.get(req.session)!; // asserted in `callback`
        const defaultLogPayload = { authBag, clientInfo, authProviderId };
        let currentGitpodUser: User | undefined = User.is(req.user) ? req.user : undefined;
        let candidate: Identity;

        const fail = (err: any) => done(err, currentGitpodUser || candidate, hints);
        const complete = () => done(undefined, currentGitpodUser || candidate, hints);

        try {
            const tokenResponseObject = this.ensureIsObject(tokenResponse);
            const { authUser, blockUser, currentScopes, envVars } = await this.fetchAuthUserSetup(accessToken, tokenResponseObject);
            const { authId, authName, primaryEmail } = authUser;
            candidate = { authProviderId, ...authUser };

            log.info(`(${strategyName}) Verify function called. for authName: ${authName}`, { ...defaultLogPayload, authUser });

            if (!currentGitpodUser) { // i.e. no user session available

                // try to find our Gitpod user 
                // 1) by identity
                // 2) by email.
                currentGitpodUser = await this.userDb.findUserByIdentity(candidate);
                if (!currentGitpodUser) {
                    // - findUsersByEmail is supposed to return users ordered descending by last login time
                    // - we pick the most recently used one and let the old onces "dry out"
                    const usersWithSamePrimaryEmail = await this.userDb.findUsersByEmail(primaryEmail);
                    if (usersWithSamePrimaryEmail.length > 0) {
                        currentGitpodUser = usersWithSamePrimaryEmail[0];
                    }
                }

            } else { // current Gitpod user known from session

                if (!currentGitpodUser.identities.some(i => i.authId === authId)) { // current Gitpod user has no such identity. 

                    // there might be another Gitpod user linked with this identity.
                    // on completion this identity will be associated with current user, thus log this change.
                    const userWithSameIdentity = await this.userDb.findUserByIdentity({ authProviderId, authId });
                    if (userWithSameIdentity) {
                        log.info(`(${strategyName}) Moving identity to the current Gitpod user.`, { ...defaultLogPayload, authUser, candidate, currentGitpodUser, userWithSameIdentity, clientInfo });
                    }
                }
            }

            hints.termsAcceptanceRequired = await this.userService.checkTermsAcceptanceRequired({ config, identity: candidate, user: currentGitpodUser });

            if (!currentGitpodUser && !hints.termsAcceptanceRequired) {
                // in a special case we may create new users without terms flow

                currentGitpodUser = await this.userService.createUserForIdentity(candidate, blockUser);
            }

            hints.isBlocked = await this.userService.checkIsBlocked({ primaryEmail, user: currentGitpodUser });

            if (!currentGitpodUser) {
                
                complete();
                return;
            }

            /*
             * At this point we have found/created a Gitpod user and the user profile/setup is fetched, let's update the link!
             */

            const existingIdentity = currentGitpodUser.identities.find(i => Identity.equals(i, candidate));
            if (existingIdentity) {
                candidate = existingIdentity;
                let shouldElevate = false;
                let prevScopes: string[] = [];
                try {
                    const token = await this.getCurrentToken(currentGitpodUser);
                    prevScopes = token ? token.scopes : prevScopes;
                    shouldElevate = this.prevScopesAreMissing(currentScopes, prevScopes);
                } catch {
                    // no token
                }
                if (shouldElevate) {
                    log.info(`(${strategyName}) Existing user needs to elevate scopes.`, { ...defaultLogPayload, identity: candidate });
                    hints.elevateScopes = prevScopes;
                }
            }

            // ensure single identity per auth provider instance
            currentGitpodUser.identities = currentGitpodUser.identities.filter(i => i.authProviderId !== authProviderId);
            currentGitpodUser.identities.push(candidate);

            // update user
            currentGitpodUser.name = authUser.authName || currentGitpodUser.name;
            currentGitpodUser.avatarUrl = authUser.avatarUrl || currentGitpodUser.avatarUrl;

            // update token, scopes, and email
            const now = new Date();
            const updateDate = now.toISOString();
            const tokenExpiresInSeconds = typeof tokenResponse.expires_in === "number" ? tokenResponse.expires_in : undefined;
            const expiryDate = tokenExpiresInSeconds ? new Date(now.getTime() + tokenExpiresInSeconds * 1000).toISOString() : undefined;
            const token: Token = {
                value: accessToken,
                username: this.tokenUsername,
                scopes: currentScopes,
                updateDate,
                expiryDate,
                refreshToken
            };
            candidate.primaryEmail = authUser.primaryEmail; // case: changed email
            candidate.authName = authUser.authName; // case: renamed account

            await this.userDb.storeUser(currentGitpodUser);
            await this.userDb.storeSingleToken(candidate, token);
            await this.updateEnvVars(currentGitpodUser, envVars);
            await this.createGhProxyIdentityOnDemand(currentGitpodUser, candidate);

            complete()
        } catch (err) {
            log.error(`(${strategyName}) Exception in verify function`, err, { ...defaultLogPayload, err, authBag });
            fail(err);
        }
    }

    protected get tokenUsername(): string {
        return "oauth2";
    }

    protected async fetchAuthUserSetup(accessToken: string, tokenResponse: object): Promise<AuthUserSetup> {
        if (!this.readAuthUserSetup) {
            throw new Error(`(${this.strategyName}) is missing configuration for reading of user information.`);
        }
        return this.readAuthUserSetup(accessToken, tokenResponse);
    }

    protected ensureIsObject(value: any): object {
        if (typeof value === "object") {
            return value;
        }
        return {};
    }

    protected async getCurrentToken(user: User) {
        try {
            const token = await this.tokenProvider.getTokenForHost(user, this.host);
            return token;
        } catch {
            // no token
        }
    }

    protected prevScopesAreMissing(currentScopes: string[], prevScopes: string[]): boolean {
        const set = new Set(prevScopes);
        currentScopes.forEach(s => set.delete(s));
        return set.size > 0;
    }

    protected async updateEnvVars(user: User, envVars?: UserEnvVarValue[]) {
        if (!envVars) {
            return;
        }
        const userId = user.id;
        const currentEnvVars = await this.userDb.getEnvVars(userId);
        const findEnvVar = (name: string, repositoryPattern: string) => currentEnvVars.find(env => env.repositoryPattern === repositoryPattern && env.name === name);
        for (const { name, value, repositoryPattern } of envVars) {
            try {
                const existingEnvVar = findEnvVar(name, repositoryPattern);
                await this.userDb.setEnvVar(existingEnvVar ? {
                    ...existingEnvVar,
                    value
                } : {
                        repositoryPattern,
                        name,
                        userId,
                        id: uuidv4(),
                        value
                    });
            } catch (error) {
                log.error(`(${this.strategyName}) Failed update Env Vars`, { error, user, envVars });
            }
        }
    }

    protected async createGhProxyIdentityOnDemand(user: User, originalIdentity: Identity) {
        const githubTokenValue = this.config.params && this.config.params.githubToken;
        if (!githubTokenValue) {
            return;
        }
        const publicGitHubAuthProviderId = "Public-GitHub";
        if (user.identities.some(i => i.authProviderId === publicGitHubAuthProviderId)) {
            return;
        }

        const githubIdentity: Identity = {
            authProviderId: publicGitHubAuthProviderId,
            authId: `proxy-${originalIdentity.authId}`,
            authName: `proxy-${originalIdentity.authName}`,
            primaryEmail: originalIdentity.primaryEmail,
            readonly: false // THIS ENABLES US TO UPGRADE FROM PROXY TO REAL GITHUB ACCOUNT
        }
        // create a proxy identity to allow access GitHub API
        user.identities.push(githubIdentity);
        const githubToken: Token = {
            value: githubTokenValue,
            username: "oauth2",
            scopes: ["user:email"],
            updateDate: new Date().toISOString()
        };
        await Promise.all([
            this.userDb.storeUser(user),
            this.userDb.storeSingleToken(githubIdentity, githubToken)
        ]);
    }

    protected isOAuthError(err: any): boolean {
        if (typeof err === "object" && (err.name == "InternalOAuthError" || err.name === "AuthorizationError")) {
            return true;
        }
        return false;
    }

    protected get defaultStrategyOptions(): StrategyOptionsWithRequest {
        const { authorizationUrl, tokenUrl, clientId, clientSecret, callBackUrl, scope, scopeSeparator, authorizationParams } = this.oauthConfig;
        const augmentedAuthParams = this.env.devBranch ? { ...authorizationParams, state: this.env.devBranch } : authorizationParams;
        return {
            authorizationURL: authorizationUrl,
            tokenURL: tokenUrl,
            // skipUserProfile: true, // default!
            clientID: clientId,
            clientSecret: clientSecret,
            callbackURL: callBackUrl,
            scope,
            scopeSeparator: scopeSeparator || " ",
            userAgent: this.USER_AGENT,
            passReqToCallback: true,
            authorizationParams: augmentedAuthParams
        };
    }

    protected getSorryUrl(message: string) {
        return this.env.hostUrl.with({ pathname: `/sorry`, hash: message }).toString();
    }

}

interface GenericOAuthStrategyOptions {
    scope?: string | string[];
    /**
     * This should be Gitpod's hostname.
     */
    userAgent: string;

    scopeSeparator?: string;
    customHeaders?: any;
    skipUserProfile?: true;
    /**
     * Non-spec autorization params.
     */
    authorizationParams?: object;
}

export interface StrategyOptionsWithRequest extends OAuth2Strategy.StrategyOptionsWithRequest, GenericOAuthStrategyOptions { }

export class GenericOAuth2Strategy extends OAuth2Strategy {

    protected refreshOAuth2: OAuth2;
    constructor(readonly name: string, options: StrategyOptionsWithRequest, verify: OAuth2Strategy.VerifyFunctionWithRequest) {
        super(GenericOAuth2Strategy.augmentOptions(options), verify);
        this._oauth2.useAuthorizationHeaderforGET(true);
        this.patch_getOAuthAccessToken();

        // init a second instance of OAuth2 handler for refresh
        const oa2 = this._oauth2 as any;
        this.refreshOAuth2 = new OAuth2(
            oa2._clientId,
            oa2._clientSecret,
            oa2._baseSite,
            oa2._authorizeUrl,
            oa2._accessTokenUrl,
            oa2._customHeaders);
        this.refreshOAuth2.getOAuthAccessToken = oa2.getOAuthAccessToken;
    }

    requestNewAccessToken(refreshToken: string, params: any, callback: oauth2tokenCallback) {
        params = params || {};
        params.grant_type = "refresh_token";
        this.refreshOAuth2.getOAuthAccessToken(refreshToken, params, callback);
    }

    protected patch_getOAuthAccessToken() {
        const oauth2 = this._oauth2;
        const _oauth2_getOAuthAccessToken = oauth2.getOAuthAccessToken as (code: string, params: any, callback: oauth2tokenCallback) => void;
        (oauth2 as any).getOAuthAccessToken = (code: string, params: any, callback: oauth2tokenCallback) => {
            const patchedCallback: oauth2tokenCallback = (err, accessToken, refreshToken, params) => {
                if (err) { return callback(err, null as any, null as any, null as any); }
                if (!accessToken) {
                    return callback({
                        statusCode: 400,
                        data: JSON.stringify(params)
                    }, null as any, null as any, null as any);
                }
                callback(null as any, accessToken, refreshToken, params);
            };
            _oauth2_getOAuthAccessToken.call(oauth2, code, params, patchedCallback);
        }
    }

    static augmentOptions(options: StrategyOptionsWithRequest): StrategyOptionsWithRequest {
        const result: StrategyOptionsWithRequest = { ...options };
        result.scopeSeparator = result.scopeSeparator || ',';
        result.customHeaders = result.customHeaders || {};
        if (!result.customHeaders['User-Agent']) {
            result.customHeaders['User-Agent'] = result.userAgent;
        }
        result.skipUserProfile = true;
        return result;
    }

    authorizationParams(options: StrategyOptionsWithRequest): object {
        if (options.authorizationParams) {
            return { ...options.authorizationParams };
        }
        return {};
    }

}
