import ipLib from 'ip';
import jwtUtil from './util/jwt-util.js';

class AuthService {
    constructor(ctx) {
        this._authConfig = ctx.config.auth;
        this._repository = ctx.repositoryModuleManager;
        this._logger = ctx.logger;
    }

    /**
     * Authenticate users based on provided ip and token
     * @param ip
     * @param token
     * @returns {boolean}
     */
    async authenticate(ip, token) {
        const isWhitelisted = this._isIpWhitelisted(ip);
        const isTokenValid = await this._isTokenValid(token);

        const isAuthenticated = isWhitelisted && isTokenValid;

        if (!isAuthenticated) {
            this._logMessage('Received unauthenticated request.');
        }

        return isAuthenticated;
    }

    /**
     * Checks whether user whose token is provided has abilities for system operation
     * @param token
     * @param systemOperation
     * @returns {Promise<boolean|*>}
     */
    async isAuthorized(token, systemOperation) {
        if (!this._authConfig.tokenBasedAuthEnabled) {
            return true;
        }

        const tokenId = jwtUtil.getPayload(token).jti;
        const abilities = await this._repository.getTokenAbilities(tokenId);

        const isAuthorized = abilities.includes(systemOperation);

        const logMessage = isAuthorized
            ? `Token ${tokenId} is successfully authenticated and authorized.`
            : `Received unauthorized request.`;

        this._logMessage(logMessage);

        return isAuthorized;
    }

    /**
     * Determines whether operation is listed in config.auth.publicOperations
     * @param operationName
     * @returns {boolean}
     */
    isPublicOperation(operationName) {
        if (!Array.isArray(this._authConfig.publicOperations)) {
            return false;
        }

        return this._authConfig.publicOperations.includes(operationName);
    }

    /**
     * Validates token structure and revoked status
     * If ot-node is configured not to do a token based auth, it will return true
     * @param token
     * @returns {boolean}
     * @private
     */
    async _isTokenValid(token) {
        if (!this._authConfig.tokenBasedAuthEnabled) {
            return true;
        }

        if (!jwtUtil.validateJWT(token)) {
            return false;
        }

        const isRevoked = await this._isTokenRevoked(token);

        return isRevoked !== null && !isRevoked;
    }

    /**
     * Checks whether provided ip is whitelisted in config
     * Returns false if ip based auth is disabled
     * @param reqIp
     * @returns {boolean}
     * @private
     */
    _isIpWhitelisted(reqIp) {
        if (!this._authConfig.ipBasedAuthEnabled) {
            return true;
        }

        for (const whitelistedIp of this._authConfig.ipWhitelist) {
            let isEqual = false;

            try {
                isEqual = ipLib.isEqual(reqIp, whitelistedIp);
            } catch (e) {
                // if ip is not valid IP isEqual should remain false
            }

            if (isEqual) {
                return true;
            }
        }

        return false;
    }

    /**
     * Checks whether provided token is revoked
     * Returns false if token based auth is disabled
     * @param token
     * @returns {Promise<boolean|*>|boolean}
     * @private
     */
    _isTokenRevoked(token) {
        if (!this._authConfig.tokenBasedAuthEnabled) {
            return false;
        }

        const tokenId = jwtUtil.getPayload(token).jti;

        return this._repository.isTokenRevoked(tokenId);
    }

    /**
     * Logs message if loggingEnabled is set to true
     * @param message
     * @private
     */
    _logMessage(message) {
        if (this._authConfig.loggingEnabled) {
            this._logger.info(`[AUTH] ${message}`);
        }
    }
}

export default AuthService;
