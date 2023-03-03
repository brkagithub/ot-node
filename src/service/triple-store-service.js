import { formatAssertion } from 'assertion-tools';

import { SCHEMA_CONTEXT, TRIPLE_STORE_REPOSITORIES } from '../constants/constants.js';

class TripleStoreService {
    constructor(ctx) {
        this.config = ctx.config;
        this.logger = ctx.logger;

        this.tripleStoreModuleManager = ctx.tripleStoreModuleManager;
        this.ualService = ctx.ualService;
        this.dataService = ctx.dataService;

        this.repositoryImplementations = {};
        for (const implementationName of this.tripleStoreModuleManager.getImplementationNames()) {
            for (const repository in this.tripleStoreModuleManager.getImplementation(
                implementationName,
            ).module.repositories) {
                this.repositoryImplementations[repository] = implementationName;
            }
        }
    }

    async localStoreAssertion(assertionId, assertion, operationId) {
        this.logger.info(
            `Inserting assertion with id: ${assertionId} in triple store. Operation id: ${operationId}`,
        );

        await this.tripleStoreModuleManager.insertAssertion(
            this.repositoryImplementations[TRIPLE_STORE_REPOSITORIES.PRIVATE_CURRENT],
            TRIPLE_STORE_REPOSITORIES.PRIVATE_CURRENT,
            assertionId,
            assertion.join('\n'),
        );
    }

    async localStoreAsset(
        repository,
        assertionId,
        assertion,
        blockchain,
        contract,
        tokenId,
        agreementStartTime,
        agreementEndTime,
        keyword,
    ) {
        const ual = this.ualService.deriveUAL(blockchain, contract, tokenId);

        this.logger.info(
            `Inserting asset with assertion id: ${assertionId}, ual: ${ual} in triple store ${repository} repository.`,
        );

        const currentAssetNquads = await formatAssertion({
            '@context': SCHEMA_CONTEXT,
            '@id': ual,
            blockchain,
            contract,
            tokenId,
            assertion: { '@id': `assertion:${assertionId}` },
            agreementStartTime,
            agreementEndTime,
            keyword,
        });

        await Promise.all([
            this.tripleStoreModuleManager.insertAssetMetadata(
                this.repositoryImplementations[repository],
                repository,
                ual,
                currentAssetNquads.join('\n'),
            ),
            this.tripleStoreModuleManager.insertAssertion(
                this.repositoryImplementations[repository],
                repository,
                assertionId,
                assertion.join('\n'),
            ),
        ]);

        this.logger.info(
            `Asset with assertion id: ${assertionId}, ual: ${ual} has been successfully inserted!`,
        );
    }

    async deleteAssetMetadata(repository, blockchain, contract, tokenId) {
        const ual = this.ualService.deriveUAL(blockchain, contract, tokenId);
        this.logger.info(`Deleting metadata for asset with ual: ${ual} from triple store ${repository} repository.`);

        return this.tripleStoreModuleManager.deleteAssetMetadata(
            this.repositoryImplementations[repository],
            repository,
            ual,
        );
    }

    async deleteAssertion(repository, assertionId) {
        this.logger.info(
            `Deleting assertion with id: ${assertionId} from triple store ${repository} repository.`,
        );
        return this.tripleStoreModuleManager.deleteAssertion(
            this.repositoryImplementations[repository],
            repository,
            assertionId,
        );
    }

    async countAssetsWithAssertionId(repository, assertionId) {
        const bindings = await this.tripleStoreModuleManager.countAssetsWithAssertionId(
            this.repositoryImplementations[repository],
            repository,
            assertionId,
        );

        return this.dataService.parseBindings(bindings);
    }

    async localGet(assertionId, localQuery = false) {
        let nquads;
        if (localQuery) {
            this.logger.debug(
                `Getting assertion: ${assertionId} from ${TRIPLE_STORE_REPOSITORIES.PRIVATE_CURRENT} repository`,
            );

            nquads = await this.tripleStoreModuleManager.getAssertion(
                this.repositoryImplementations[TRIPLE_STORE_REPOSITORIES.PRIVATE_CURRENT],
                TRIPLE_STORE_REPOSITORIES.PRIVATE_CURRENT,
                assertionId,
            );
        }
        if (!nquads?.length) {
            this.logger.debug(
                `Getting assertion: ${assertionId} from ${TRIPLE_STORE_REPOSITORIES.PUBLIC_CURRENT} repository`,
            );
            nquads = await this.tripleStoreModuleManager.getAssertion(
                this.repositoryImplementations[TRIPLE_STORE_REPOSITORIES.PUBLIC_CURRENT],
                TRIPLE_STORE_REPOSITORIES.PUBLIC_CURRENT,
                assertionId,
            );
        }
        nquads = await this.dataService.toNQuads(nquads, 'application/n-quads');

        this.logger.debug(
            `Assertion: ${assertionId} ${nquads.length ? '' : 'not'} found in local triple store.`,
        );

        if (nquads.length) {
            this.logger.debug(`Number of n-quads retrieved from triple store : ${nquads.length}`);
        }

        return nquads;
    }

    async assetExists(repository, blockchain, contract, tokenId) {
        return this.tripleStoreModuleManager.assetExists(
            this.repositoryImplementations[repository],
            repository,
            this.ualService.deriveUAL(blockchain, contract, tokenId),
            blockchain,
            contract,
            tokenId,
        );
    }

    async getAssetMetadata(repository, blockchain, contract, tokenId) {
        const bindings = await this.tripleStoreModuleManager.getAssetMetadata(
            this.repositoryImplementations[repository],
            repository,
            this.ualService.deriveUAL(blockchain, contract, tokenId),
        );
        return this.dataService.parseBindings(bindings);
    }

    async assertionExists(repository, assertionId) {
        return this.tripleStoreModuleManager.assertionExists(
            this.repositoryImplementations[repository],
            repository,
            assertionId,
        );
    }

    async construct(repository, query) {
        return this.tripleStoreModuleManager.construct(
            this.repositoryImplementations[repository],
            repository,
            query,
        );
    }

    async select(repository, query) {
        return this.tripleStoreModuleManager.select(
            this.repositoryImplementations[repository],
            repository,
            query,
        );
    }
}

export default TripleStoreService;
