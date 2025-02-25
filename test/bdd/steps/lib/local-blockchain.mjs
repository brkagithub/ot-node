/* eslint-disable max-len */

import { ethers } from 'ethers';
import { readFile } from 'fs/promises';
import { exec } from 'child_process';

const Hub = JSON.parse((await readFile('node_modules/dkg-evm-module/abi/Hub.json')).toString());
const ParametersStorage = JSON.parse(
    (await readFile('node_modules/dkg-evm-module/abi/ParametersStorage.json')).toString(),
);

const hubContractAddress = '0x5FbDB2315678afecb367f032d93F642f64180aa3';

const testParametersStorageParams = {
    epochLength: 6 * 60, // 6 minutes
    commitWindowDurationPerc: 33, // 2 minutes
    minProofWindowOffsetPerc: 66, // 4 minutes
    maxProofWindowOffsetPerc: 66, // 4 minutes
    proofWindowDurationPerc: 33, // 2 minutes
    finalizationCommitsNumber: 3,
};
/**
 * LocalBlockchain represent small wrapper around the Ganache.
 *
 * LocalBlockchain uses the Ganache-core to run in-memory blockchain simulator. It uses
 * predefined accounts that can be fetch by calling LocalBlockchain.wallets(). Account with
 * index 7 is used for deploying contracts.
 *
 * Basic usage:
 * LocalBlockchain.wallets()[9].instance.address
 * LocalBlockchain.wallets()[9].privateKey,
 *
 * const localBlockchain = new LocalBlockchain({ logger: this.logger });
 * await localBlockchain.initialize(); // Init the server.
 * // That will compile and deploy contracts. Later can be called
 * // deployContracts() to re-deploy fresh contracts.
 *
 * // After usage:
 *     if (localBlockchain.server) {
 *         this.state.localBlockchain.server.close();
 *     }
 *
 * @param {String} [options.logger] - Logger instance with debug, trace, info and error methods.
 */

let startBlockchainProcess;

class LocalBlockchain {
    async initialize(_console = console) {
        startBlockchainProcess = exec('npm run start:local_blockchain');
        startBlockchainProcess.stdout.on('data', (data) => {
            _console.log(data);
        });

        this.provider = new ethers.providers.JsonRpcProvider('http://localhost:8545');

        const [privateKeysFile, publicKeysFile] = await Promise.all([
            readFile('test/bdd/steps/api/datasets/privateKeys.json'),
            readFile('test/bdd/steps/api/datasets/publicKeys.json'),
        ]);

        const privateKeys = JSON.parse(privateKeysFile.toString());
        const publicKeys = JSON.parse(publicKeysFile.toString());

        this.wallets = privateKeys.map((privateKey, index) => ({
            address: publicKeys[index],
            privateKey,
        }));


        const wallet = new ethers.Wallet(this.wallets[0].privateKey, this.provider);
        this.hubContract = new ethers.Contract(hubContractAddress, Hub, wallet);

        await this.provider.ready;
        const parametersStorageAddress = await this.hubContract.getContractAddress(
            'ParametersStorage',
        );
        this.ParametersStorageContract = new ethers.Contract(
            parametersStorageAddress,
            ParametersStorage,
            wallet,
        );
        await this.setParametersStorageParams(testParametersStorageParams);
    }

    stop() {
        startBlockchainProcess.kill();
    }

    getWallets() {
        return this.wallets;
    }

    async setParametersStorageParams(params) {
        for (const parameter of Object.keys(params)) {
            const blockchainMethodName = `set${
                parameter.charAt(0).toUpperCase() + parameter.slice(1)
            }`;
            console.log(`Setting ${parameter} in parameters storage to: ${params[parameter]}`);
            // eslint-disable-next-line no-await-in-loop
            await this.ParametersStorageContract[blockchainMethodName](params[parameter], {
                gasLimit: 100000,
            });
        }
    }

    async setR1(R1) {
        console.log(`Setting R1 in parameters storage to: ${R1}`);
        await this.ParametersStorageContract.setR1(R1, {
            gasLimit: 100000,
        });
    }

    async setR0(R0) {
        console.log(`Setting R0 in parameters storage to: ${R0}`);
        await this.ParametersStorageContract.setR0(R0, {
            gasLimit: 100000,
        });
    }
}

export default LocalBlockchain;
