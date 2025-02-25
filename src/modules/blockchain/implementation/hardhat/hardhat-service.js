import Web3Service from '../web3-service.js';

class HardhatService extends Web3Service {
    constructor(ctx) {
        super(ctx);
        this.baseTokenTicker = 'HARDHAT_TOKENS';
        this.tracTicker = 'gTRAC';
    }

    async getBlockchainTimestamp() {
        const latestBlock = await super.getLatestBlock();
        return latestBlock.timestamp;
    }

    async providerReady() {
        return this.provider.ready;
    }
}

export default HardhatService;
