import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const DUMMY_ADDRESS = '0x' + 'f'.repeat(40);

const invalidButNonZeroLocatorConfig = {
  accountingOracle: DUMMY_ADDRESS,
  depositSecurityModule: DUMMY_ADDRESS,
  elRewardsVault: DUMMY_ADDRESS,
  legacyOracle: DUMMY_ADDRESS,
  lido: DUMMY_ADDRESS,
  oracleReportSanityChecker: DUMMY_ADDRESS,
  postTokenRebaseReceiver: DUMMY_ADDRESS,
  burner: DUMMY_ADDRESS,
  stakingRouter: DUMMY_ADDRESS,
  treasury: DUMMY_ADDRESS,
  validatorsExitBusOracle: DUMMY_ADDRESS,
  withdrawalQueue: DUMMY_ADDRESS,
  withdrawalVault: DUMMY_ADDRESS,
  oracleDaemonConfig: DUMMY_ADDRESS,
};

async function deployBehindOssifiableProxy(artifactName: string, proxyOwner: string, constructorArgs: unknown[]) {
  const contractFactory = await ethers.getContractFactory(artifactName);
  const implementation = await contractFactory.deploy(...constructorArgs, { from: proxyOwner });

  const proxyFactory = await ethers.getContractFactory('OssifiableProxy');
  const proxy = await proxyFactory.deploy(
    await implementation.getAddress(), proxyOwner, new Uint8Array(), { from: proxyOwner });

  return proxy;
}

async function updateProxyImplementation(proxyAddress: string, artifactName: string, proxyOwner: string, constructorArgs: unknown[]) {
  const proxy = await ethers.getContractAt('OssifiableProxy', proxyAddress);

  const contractFactory = await ethers.getContractFactory(artifactName);
  const implementation = await contractFactory.deploy(...constructorArgs, {from: proxyOwner});

  await proxy.proxy__upgradeTo(await implementation.getAddress());
}

async function getLocatorConfig(locatorAddress: string) {
  const locator = await ethers.getContractAt('LidoLocator', locatorAddress);
  const config = {
    accountingOracle: await locator.accountingOracle(),
    depositSecurityModule: await locator.depositSecurityModule(),
    elRewardsVault: await locator.elRewardsVault(),
    legacyOracle: await locator.legacyOracle(),
    lido: await locator.lido(),
    oracleReportSanityChecker: await locator.oracleReportSanityChecker(),
    postTokenRebaseReceiver: await locator.postTokenRebaseReceiver(),
    burner: await locator.burner(),
    stakingRouter: await locator.stakingRouter(),
    treasury: await locator.treasury(),
    validatorsExitBusOracle: await locator.validatorsExitBusOracle(),
    withdrawalQueue: await locator.withdrawalQueue(),
    withdrawalVault: await locator.withdrawalVault(),
    oracleDaemonConfig: await locator.oracleDaemonConfig(),
  };
  return config;
}

export async function deployLocatorWithDummyAddressesImplementation(admin: string) {
  const proxy = await deployBehindOssifiableProxy('LidoLocator', admin, [
    invalidButNonZeroLocatorConfig
  ]);
  return await ethers.getContractAt('LidoLocator', await proxy.getAddress());
}

/// ! Not specified in configUpdate values are set to dummy non zero addresses
export async function updateLocatorImplementation(locatorAddress: string, admin: string, configUpdate = {}) {
  const config = await getLocatorConfig(locatorAddress);
  Object.assign(config, configUpdate);
  await updateProxyImplementation(locatorAddress, 'LidoLocator', admin, [config]);
}
