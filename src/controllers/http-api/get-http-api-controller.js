import {
    OPERATION_ID_STATUS,
    OPERATION_STATUS,
    CONTENT_ASSET_HASH_FUNCTION_ID,
    DEFAULT_GET_STATE,
} from '../../constants/constants.js';
import BaseController from './base-http-api-controller.js';

class GetController extends BaseController {
    constructor(ctx) {
        super(ctx);
        this.commandExecutor = ctx.commandExecutor;
        this.operationIdService = ctx.operationIdService;
        this.getService = ctx.getService;
        this.repositoryModuleManager = ctx.repositoryModuleManager;
    }

    async handleGetRequest(req, res) {
        const operationId = await this.operationIdService.generateOperationId(
            OPERATION_ID_STATUS.GET.GET_START,
        );

        await this.operationIdService.updateOperationIdStatus(
            operationId,
            OPERATION_ID_STATUS.GET.GET_INIT_START,
        );

        this.returnResponse(res, 202, {
            operationId,
        });

        await this.repositoryModuleManager.createOperationRecord(
            this.getService.getOperationName(),
            operationId,
            OPERATION_STATUS.IN_PROGRESS,
        );

        const { id } = req.body;
        const state = req.body.state ?? DEFAULT_GET_STATE;
        const hashFunctionId = req.body.hashFunctionId ?? CONTENT_ASSET_HASH_FUNCTION_ID;

        this.logger.info(`Get for ${id} with operation id ${operationId} initiated.`);

        const commandSequence = [
            'getLatestAssertionIdCommand',
            'localGetCommand',
            'networkGetCommand',
        ];

        await this.commandExecutor.add({
            name: commandSequence[0],
            sequence: commandSequence.slice(1),
            delay: 0,
            data: {
                operationId,
                id,
                state,
                hashFunctionId,
            },
            transactional: false,
        });

        await this.operationIdService.updateOperationIdStatus(
            operationId,
            OPERATION_ID_STATUS.GET.GET_INIT_END,
        );
    }
}

export default GetController;
