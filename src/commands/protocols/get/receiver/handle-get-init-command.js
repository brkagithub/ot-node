const HandleProtocolMessageCommand = require('../../common/handle-protocol-message-command');
const {
    ERROR_TYPE,
    NETWORK_MESSAGE_TYPES,
    OPERATION_ID_STATUS,
} = require('../../../../constants/constants');

class HandleGetInitCommand extends HandleProtocolMessageCommand {
    constructor(ctx) {
        super(ctx);
        this.tripleStoreModuleManager = ctx.tripleStoreModuleManager;
        this.operationService = ctx.getService;
    }

    async prepareMessage(commandData) {
        const { ual, assertionId, operationId } = commandData;
        await this.operationIdService.updateOperationIdStatus(
            operationId,
            OPERATION_ID_STATUS.GET.ASSERTION_EXISTS_LOCAL_START,
        );

        const assertionExists = await this.tripleStoreModuleManager.assertionExists(
            `${ual}/${assertionId}`,
        );
        const messageType = assertionExists
            ? NETWORK_MESSAGE_TYPES.RESPONSES.ACK
            : NETWORK_MESSAGE_TYPES.RESPONSES.NACK;

        await this.operationIdService.updateOperationIdStatus(
            operationId,
            OPERATION_ID_STATUS.GET.ASSERTION_EXISTS_LOCAL_END,
        );

        return { messageType, messageData: {} };
    }

    /**
     * Builds default handleGetInitCommand
     * @param map
     * @returns {{add, data: *, delay: *, deadline: *}}
     */
    default(map) {
        const command = {
            name: 'handleGetInitCommand',
            delay: 0,
            transactional: false,
            errorType: ERROR_TYPE.HANDLE_GET_INIT_ERROR,
        };
        Object.assign(command, map);
        return command;
    }
}

module.exports = HandleGetInitCommand;
