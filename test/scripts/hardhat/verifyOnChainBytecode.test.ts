/**
 * Copyright 2024 Circle Internet Group, Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import hre from "hardhat";
import * as fs from "fs";
import * as sinon from "sinon";
import {
  verifyOnChainBytecode,
  BytecodeInputType,
  BytecodeVerificationType,
  extractBytecodeFromGethTraces,
} from "../../../scripts/hardhat/verifyOnChainBytecode";
import { BaseContract, Contract, ContractTransactionResponse } from "ethers";
import { mkdirSync, writeFileSync } from "fs";
import { HARDHAT_ACCOUNTS } from "../../helpers/constants";
import {
  ArtifactType,
  opMainnetFiatTokenProxyContractCreationBytecode,
} from "../../../scripts/hardhat/alternativeArtifacts";
import V2_2UpgraderDeploymentTrace from "./testData/V2_2UpgraderDeploymentTrace.json";
import * as Helpers from "../../../scripts/hardhat/helpers";

describe("Verify on chain bytecode", () => {
  let proxy: Contract;
  let v22: Contract;
  let signatureChecker: Contract;
  let opMainnetArtifactFiatTokenProxy: BaseContract & {
    deploymentTransaction(): ContractTransactionResponse;
  };
  let execSyncWrapperStub: sinon.SinonStub<[string], void>;

  before("setup", async () => {
    signatureChecker = await hre.ethers.deployContract("SignatureChecker");
    const FiatTokenV2_2 = await hre.ethers.getContractFactory("FiatTokenV2_2", {
      signer: await hre.ethers.getSigner(HARDHAT_ACCOUNTS[0]),
      libraries: { SignatureChecker: signatureChecker.target },
    });
    v22 = await FiatTokenV2_2.deploy();
    proxy = await hre.ethers.deployContract("FiatTokenProxy", [v22.target]);

    // deploy a contract using the OP Mainnet artifact
    const opMainnetFiatTokenProxyFactory = new hre.ethers.ContractFactory(
      [],
      opMainnetFiatTokenProxyContractCreationBytecode.slice(0, -40) +
        (await v22.getAddress()).slice(2),
      await hre.ethers.getSigner(HARDHAT_ACCOUNTS[0])
    );
    opMainnetArtifactFiatTokenProxy = await opMainnetFiatTokenProxyFactory.deploy();
    await opMainnetArtifactFiatTokenProxy.waitForDeployment();
  });

  beforeEach(() => {
    execSyncWrapperStub = sinon.stub(Helpers, "execSyncWrapper");
  });

  afterEach(() => {
    sinon.restore();
  });

  it("rejects for an improper optimizerRuns", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const improperOptimizerRuns: any[] = ["&& do something", 1.1, -1, "1000"];

    for (const improperOptimizerRun in improperOptimizerRuns) {
      await expect(
        verifyOnChainBytecode(
          {
            contractName: "FiatTokenProxy",
            contractAddress: proxy.target as string,
            verificationType: BytecodeVerificationType.Partial,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            optimizerRuns: improperOptimizerRun as any,
          },
          hre
        )
      ).to.be.rejectedWith("invalid optimizerRuns");
    }
  });

  it("will execute the expected forge command when optimizerRuns is present", async () => {
    const results = await verifyOnChainBytecode(
      {
        contractName: "FiatTokenProxy",
        contractAddress: proxy.target as string,
        verificationType: BytecodeVerificationType.Partial,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        optimizerRuns: 1000,
      },
      hre
    );

    expect(results).to.deep.equal([
      { type: BytecodeInputType.RuntimeBytecodePartial, equal: true },
    ]);

    expect(
      execSyncWrapperStub.calledOnceWithExactly(
        "forge build --optimizer-runs 1000"
      )
    ).to.be.true;
  });

  it("Can detect mismatched metadata input", async () => {
    const results = await verifyOnChainBytecode(
      {
        contractName: "FiatTokenProxy",
        contractAddress: proxy.target as string,
        verificationType: BytecodeVerificationType.Partial,
        metadataFilePath:
          // Contains mismatched metadata (auto generated by foundry instead of hardhat)
          "test/scripts/hardhat/testData/FiatTokenProxy.metadata.json",
      },
      hre
    );

    expect(results).to.deep.equal([
      { type: BytecodeInputType.RuntimeBytecodePartial, equal: true },
      { type: BytecodeInputType.MetadataHash, equal: false },
    ]);
  });

  it("Can detect mismatched constructor code", async () => {
    expect(
      await verifyOnChainBytecode(
        {
          contractName: "FiatTokenProxy",
          contractAddress: proxy.target as string,
          verificationType: BytecodeVerificationType.Partial,
          contractCreationTxHash: v22.deploymentTransaction()?.hash, // Wrong transaction hash supplied
        },
        hre
      )
    ).to.deep.equal([
      { type: BytecodeInputType.ConstructorCode, equal: false },
      { type: BytecodeInputType.RuntimeBytecodePartial, equal: true },
    ]);
  });

  it("Can detect mismatched runtime code", async () => {
    expect(
      await verifyOnChainBytecode(
        {
          contractName: "FiatTokenProxy",
          contractAddress: v22.target as string, // Wrong contract address supplied
          verificationType: BytecodeVerificationType.Partial,
        },
        hre
      )
    ).to.deep.equal([
      { type: BytecodeInputType.RuntimeBytecodePartial, equal: false },
    ]);
  });

  it("Can run partial verification on valid FiatTokenProxy contract", async () => {
    const contractName = "FiatTokenProxy";
    const contractDir = "contracts/v1/FiatTokenProxy.sol";
    const metadataPath = await prepareMetadata(contractName, contractDir);

    const results = await verifyOnChainBytecode(
      {
        contractName,
        contractAddress: proxy.target as string,
        verificationType: BytecodeVerificationType.Partial,
        metadataFilePath: metadataPath,
        contractCreationTxHash: proxy.deploymentTransaction()?.hash,
      },
      hre
    );

    expect(results).to.deep.equal([
      { type: BytecodeInputType.ConstructorCode, equal: true },
      { type: BytecodeInputType.RuntimeBytecodePartial, equal: true },
      { type: BytecodeInputType.MetadataHash, equal: true },
    ]);
  });

  it("Can run partial verification on valid FiatTokenV2_2 contract", async () => {
    const contractName = "FiatTokenV2_2";
    const contractDir = "contracts/v2/FiatTokenV2_2.sol";
    const metadataPath = await prepareMetadata(contractName, contractDir);

    const results = await verifyOnChainBytecode(
      {
        contractName,
        contractAddress: v22.target as string,
        libraryName: "SignatureChecker",
        libraryAddress: signatureChecker.target as string,
        verificationType: BytecodeVerificationType.Partial,
        metadataFilePath: metadataPath,
        contractCreationTxHash: v22.deploymentTransaction()?.hash,
      },
      hre
    );

    expect(results).to.deep.equal([
      { type: BytecodeInputType.ConstructorCode, equal: true },
      { type: BytecodeInputType.RuntimeBytecodePartial, equal: true },
      { type: BytecodeInputType.MetadataHash, equal: true },
    ]);
  });

  it("Can run partial verification on valid SignatureChecker contract", async () => {
    const contractName = "SignatureChecker";
    const contractDir = "contracts/util/SignatureChecker.sol";
    const metadataPath = await prepareMetadata(contractName, contractDir);

    const results = await verifyOnChainBytecode(
      {
        contractName,
        contractAddress: signatureChecker.target as string,
        verificationType: BytecodeVerificationType.Partial,
        isLibrary: true,
        metadataFilePath: metadataPath,
        contractCreationTxHash: signatureChecker.deploymentTransaction()?.hash,
      },
      hre
    );

    expect(results).to.deep.equal([
      { type: BytecodeInputType.ConstructorCode, equal: true },
      { type: BytecodeInputType.RuntimeBytecodePartial, equal: true },
      { type: BytecodeInputType.MetadataHash, equal: true },
    ]);
  });

  it("Can run partial verification with bytecode input from a file", async () => {
    expect(
      await verifyOnChainBytecode(
        {
          contractName: "FiatTokenProxy",
          contractAddress: proxy.target as string,
          onchainBytecodeFilePath:
            // Contains deployed bytecode from `artifacts/foundry/FiatTokenProxy.sol/FiatTokenProxy.json`, `
            "test/scripts/hardhat/testData/FiatTokenProxy.bin",
          verificationType: BytecodeVerificationType.Partial,
        },
        hre
      )
    ).to.deep.equal([
      { type: BytecodeInputType.RuntimeBytecodePartial, equal: true },
    ]);
  });

  it("Can use an alternative artifact for verification", async () => {
    expect(
      await verifyOnChainBytecode(
        {
          contractName: "FiatTokenProxy",
          contractAddress: await opMainnetArtifactFiatTokenProxy.getAddress(),
          verificationType: BytecodeVerificationType.Full,
          artifactType: ArtifactType.OPMainnet,
          contractCreationTxHash: opMainnetArtifactFiatTokenProxy.deploymentTransaction()
            ?.hash,
        },
        hre
      )
    ).to.deep.equal([
      { type: BytecodeInputType.ConstructorCode, equal: true },
      { type: BytecodeInputType.RuntimeBytecodeFull, equal: true },
    ]);
  });

  it("Can pull contract creation code from traces", async () => {
    // example contract creation from internal transaction taken from: https://etherscan.io/tx/0x7f6268ff5bd05d1b61c19889a46eb9a38563accce441dcfcf0c7515b1733503e
    // it's the deployment of the UpgraderHelper contract for V2_2Upgrader.sol
    const expectedCreationBytecode =
      "0x" +
      fs.readFileSync(
        "test/scripts/hardhat/testData/V2_2UpgraderHelperCreationBytecode.bin",
        "utf-8"
      );
    const contractAddress = "0x4b2194B42EF7F4A41BA4cA3Df6D1E140dc9972b2";
    expect(
      extractBytecodeFromGethTraces(
        V2_2UpgraderDeploymentTrace,
        contractAddress
      )
    ).to.deep.equal(expectedCreationBytecode);
  });
});

async function prepareMetadata(
  contractName: string,
  contractDir: string
): Promise<string> {
  const buildInfo = await hre.artifacts.getBuildInfo(
    `${contractDir}:${contractName}`
  );
  const complierContractOutput = buildInfo?.output.contracts[contractDir][
    contractName
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ] as any;

  const dirPath = `artifacts/test/${contractDir}`;
  const metadataPath = `${dirPath}/${contractName}.metadata.json`;
  mkdirSync(dirPath, { recursive: true });
  writeFileSync(metadataPath, complierContractOutput.metadata, null);
  return metadataPath;
}
