import 'dotenv/config';
import { Before, BeforeAll, After, AfterAll } from '@cucumber/cucumber';
import slugify from 'slugify';
import fs from 'fs';
import { NODE_ENVIRONMENTS } from '../../../src/constants/constants.js';
import TripleStoreModuleManager from "../../../src/modules/triple-store/triple-store-module-manager.js";
import mysql from "mysql2";

process.env.NODE_ENV = NODE_ENVIRONMENTS.TEST;

BeforeAll(() => {});

Before(function beforeMethod(testCase, done) {
    this.logger = console;
    this.logger.log('\nStarting scenario: ', testCase.pickle.name, `${testCase.pickle.uri}`);
    // Initialize variables
    this.state = {};
    this.state.localBlockchain = null;
    this.state.nodes = {};
    this.state.bootstraps = [];
    let logDir = process.env.CUCUMBER_ARTIFACTS_DIR || '.';
    logDir += `/test/bdd/log/${slugify(testCase.pickle.name)}`;
    fs.mkdirSync(logDir, { recursive: true });
    this.state.scenarionLogDir = logDir;
    this.logger.log('Scenario logs can be found here: ', logDir);
    done();
});

After(function afterMethod(testCase, done) {
    const tripleStoreConfiguration = [];
    const databaseNames = [];
    for (const key in this.state.nodes) {
        this.state.nodes[key].forkedNode.kill();
        tripleStoreConfiguration.push({modules: {tripleStore: this.state.nodes[key].configuration.modules.tripleStore}});
        databaseNames.push(this.state.nodes[key].configuration.operationalDatabase.databaseName);
    }
    this.state.bootstraps.forEach((node) => {
        node.forkedNode.kill();
        tripleStoreConfiguration.push({modules: {tripleStore: node.configuration.modules.tripleStore}});
        databaseNames.push(node.configuration.operationalDatabase.databaseName);
    });
    if (this.state.localBlockchain) {
        this.state.localBlockchain.stop();
    }
    this.logger.log('After test hook, cleaning repositories');

    const promises = [];
    const con = mysql.createConnection({
        host: 'localhost',
        user: 'root',
        password: process.env.REPOSITORY_PASSWORD,
    });
    databaseNames.forEach((element) => {
        const sql = `DROP DATABASE IF EXISTS \`${element}\`;`;
        promises.push(con.promise().query(sql));
    });
    promises.push(con);
    tripleStoreConfiguration.forEach((config) => {
        promises.push(async () => {
            const tripleStoreModuleManager = new TripleStoreModuleManager({config, logger: this.logger});
            await tripleStoreModuleManager.initialize()
            for (const implementationName of tripleStoreModuleManager.getImplementationNames()) {
                const {config} = tripleStoreModuleManager.getImplementation(implementationName);
                Object.keys(config.repositories).map(async (repository) => {
                        console.log('Removing triple store configuration:', JSON.stringify(config, null, 4));
                        await tripleStoreModuleManager.deleteRepository(implementationName, repository);
                    }
                )
            }
        })
    })

    Promise.all(promises)
        .then(() => {
            con.end();
        })
        .then(() => {
            this.logger.log(
                'Completed scenario: ',
                testCase.pickle.name,
                `${testCase.gherkinDocument.uri}:${testCase.gherkinDocument.feature.location.line}`,
            );
            this.logger.log(
                'with status: ',
                testCase.result.status,
                ' and duration: ',
                testCase.result.duration,
                ' miliseconds.',
            );
            done();
        });
});

AfterAll(async () => {});

process.on('unhandledRejection', () => {
    process.abort();
});
