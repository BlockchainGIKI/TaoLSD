import { encodeBytes32String } from 'ethers';
import { ErrorDecoder } from 'ethers-decode-error'
import { artifacts, ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { DSMAttestMessage, ether, impersonate, OracleReport, shareRate, getReportDataItems, calcReportDataHash } from 'lib';
import { getProtocolContext, ProtocolContext } from "lib/protocol";

type Block = {
    number: number;
    hash: string;
  };

const HashConsensusArtifact = artifacts.readArtifactSync("HashConsensus");
const DepositSecurityModuleArtifact = artifacts.readArtifactSync("DepositSecurityModule");
const LidoArtifact = artifacts.readArtifactSync("Lido");
const WithdrawalQueueERC721Artifact = artifacts.readArtifactSync("WithdrawalQueueERC721");
const NodeOperatorsRegistryArtifact = artifacts.readArtifactSync("NodeOperatorsRegistry");
const DepositContractArtifact = artifacts.readArtifactSync("DepositContract");
const AccountingOracleArtifact = artifacts.readArtifactSync("AccountingOracle");
const errorDecoder = ErrorDecoder.create([HashConsensusArtifact.abi, DepositSecurityModuleArtifact.abi, LidoArtifact.abi, 
WithdrawalQueueERC721Artifact.abi, NodeOperatorsRegistryArtifact.abi, DepositContractArtifact.abi, AccountingOracleArtifact.abi
]);
const ZeroAddress: string = "0x0000000000000000000000000000000000000000";

async function initializeProtocol(){
    const ctx: ProtocolContext = await getProtocolContext();
    // Getting the accounts needed to execute functions
    const signers = await ethers.getSigners();
    const agentSigner = await ctx.getSigner("agent");
    // Getting contracts need to fully initialize the staking protocol
    const {hashConsensus, depositSecurityModule, lido, withdrawalQueue, nor } = ctx.contracts; 
    // Committee members already added by the deployment script
    const quorum = await hashConsensus.getQuorum() 
    console.log("Quorum:", quorum.toString());
    console.log("Committee Members:", await hashConsensus.getMembers());
    // Initial epoch already set by the deployment script
    // await hashConsensus.connect(agentSigner).updateInitialEpoch(2) ;
    try {
        // Adding guardians to DepositSecurityModule
        let guardians = await depositSecurityModule.getGuardians()
        if (guardians.length == 0){
            await depositSecurityModule.connect(agentSigner).addGuardians([signers[0].address, signers[1].address, signers[2].address], 3);
            guardians = await depositSecurityModule.getGuardians()
        }
        console.log("Guardians:", guardians);
        // Lido already resumed by deployment script
        // console.log("Resume Lido: ", await lido.connect(agentSigner).resume());
        // WithdrawalQueue already resumed by deployment script
        // console.log("Resume WithdrawalQueue", await withdrawalQueue.connect(agentSigner).resume());
        // Node operators already added by deployment script
        console.log("Node Operators Count:", await nor.connect(agentSigner).getNodeOperatorsCount());
        console.log("Active Node Operators:", await nor.getActiveNodeOperatorsCount());
        console.log("Total Signing Keys:", await nor.getTotalSigningKeyCount(1));
        console.log("Node Operator Summary:", await nor.getNodeOperatorSummary(1));
        console.log("Vetted Validators:",(await nor.getNodeOperator(1, false)).totalVettedValidators);
        console.log("Is Active:", await nor.getNodeOperatorIsActive(1));
    } catch (err) {
        const decodedError = await errorDecoder.decode(err)
        console.log("Decoded Error:", decodedError);
      }
}

async function stakeEther(){
    const ctx: ProtocolContext = await getProtocolContext();
    // Getting the accounts needed to execute functions
    const signers = await ethers.getSigners();
    const agentSigner = await ctx.getSigner("agent");
    // Getting the Lido contract
    const {lido} = ctx.contracts;
    const stakingStatus:boolean = await lido.isStakingPaused(); 
    console.log("Is staking paused?", stakingStatus);
    if(!stakingStatus){ 
        const deposit = ether("32.0");
        try{
        const depositTx = await lido.connect(signers[0]).submit(ZeroAddress, { value: deposit });
        console.log("Transaction Receipt:", depositTx);
        console.log("Balance of User:", await lido.balanceOf(signers[0]))
        console.log("Buffered Ether:", await lido.getBufferedEther());
        } catch(err){
            const decodedError = await errorDecoder.decode(err)
            console.log("Decoded Error:", decodedError);
        }
    }
}

async function getLatestBlock(): Promise<Block> {
    const block = await ethers.provider.getBlock("latest");
    if (!block) throw new Error("Failed to retrieve latest block");
    return block as Block;
  }

async function depositEther(){
    const ctx: ProtocolContext = await getProtocolContext();
    const{stakingRouter, depositSecurityModule} = ctx.contracts;
    const depositContract = await ethers.getContractAt("DepositContract", "0x5FbDB2315678afecb367f032d93F642f64180aa3");
    const signers = await ethers.getSigners();
    const stakingModules = await stakingRouter.getStakingModules();
    const guardians = await depositSecurityModule.getGuardians();
    console.log("Staking Modules:", stakingModules);
    const stakingModuleStatus:boolean = await stakingRouter.getStakingModuleIsActive(stakingModules[0][0]);
    console.log(`Is Staking Module ${stakingModules[0][0]} active: ${stakingModuleStatus}`);
    const canDeposit:boolean = await depositSecurityModule.canDeposit(stakingModules[0][0]);
    console.log(`Can Staking Module ${stakingModules[0][0]} deposit: ${canDeposit}`);
    if(stakingModuleStatus && canDeposit){
        const depositRoot = await depositContract.get_deposit_root();
        console.log("Deposit Root:", depositRoot);
        const depositNonce =  Number (await stakingRouter.getStakingModuleNonce(stakingModules[0][0]));
        console.log("Deposit Nonce:", depositNonce);
        const block:Block = await getLatestBlock();
        DSMAttestMessage.setMessagePrefix(await depositSecurityModule.ATTEST_MESSAGE_PREFIX());
        const validAttestMessage: DSMAttestMessage = new DSMAttestMessage(
            block.number,
            block.hash,
            depositRoot,
            Number (stakingModules[0][0]),
            depositNonce,
          ); 
        console.log("Index:", await depositSecurityModule.getGuardianIndex("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"));
        console.log("Index:", await depositSecurityModule.getGuardianIndex("0x70997970C51812dc3A010C7d01b50e0d17dc79C8"));
        console.log("Index:", await depositSecurityModule.getGuardianIndex("0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"));
          const sortedGuardianSignatures = [
            validAttestMessage.sign("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"),
            validAttestMessage.sign("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"),
            validAttestMessage.sign("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"),
          ];
        const depositCalldata = encodeBytes32String("");
        try{
            const tx = await depositSecurityModule
            .connect(signers[0])
            .depositBufferedEther(
              block.number,
              block.hash,
              depositRoot,
              stakingModules[0][0],
              depositNonce,
              depositCalldata,
              sortedGuardianSignatures,
            );
            console.log("Deposit Transaction:", tx);
            } catch(err){
                const decodedError = await errorDecoder.decode(err)
                console.log("Decoded Error:", decodedError);
            }
    }
}

async function topUpLido(){
    // Setting up the simulated balances in elRewards and withdrawals vaults
    const elRewardsVaultBalance = ether("100.0");
    const withdrawalsVaultBalance = ether("100.0");
    // Getting the Lido and Lido Locator contracts from the current context
    const ctx: ProtocolContext = await getProtocolContext();
    const{lido, locator} = ctx.contracts;
    // Setting up accounts that will impersonate elRewardsVault and withdrawalsVault. Only the Beacon Chain and Execution Layer can
    // deposit ether to these contracts so impersonation is necessary to simulate this action.
    const elRewardsVault: HardhatEthersSigner = await impersonate(await locator.elRewardsVault(), elRewardsVaultBalance);
    const withdrawalsVault: HardhatEthersSigner = await impersonate(await locator.withdrawalVault(), withdrawalsVaultBalance);
    // Configuring reward amounts to send to the vaults
    const elRewardsToSend = ether("1.0");
    const withdrawalsToSend = ether("1.0");
    // Sending ether to EL Rewards vault
    const receiveELRewardsTx = await lido.connect(elRewardsVault).receiveELRewards({ value: elRewardsToSend });
    console.log("Receive EL Rewards Transaction:", receiveELRewardsTx);
    const elRewards = await lido.getTotalELRewardsCollected();
    console.log("EL Rewards:", elRewards);
    // Sending ether to Withdrawal vault
    const receiveWithdrawalsTx = await lido.connect(withdrawalsVault).receiveWithdrawals({ value: withdrawalsToSend });
    console.log("Receive Withdrawals Transaction:", receiveWithdrawalsTx);
    console.log("Withdrawals Balance:", await ethers.provider.getBalance(lido.address) - elRewards);
}

async function distributeRewards(){
    console.log("Start of ftn");
    const ctx: ProtocolContext = await getProtocolContext();
    console.log("After getting context");
    const agentSigner = await ctx.getSigner("agent");
    const [signer] = await ethers.getSigners();
    const { hashConsensus, accountingOracle, lido, nor } = ctx.contracts;
    console.log("Before try");
    try{
        const managementRole = await hashConsensus.MANAGE_MEMBERS_AND_QUORUM_ROLE();
        const managementRoleStatus: boolean = await hashConsensus.hasRole(managementRole, agentSigner.address);
        const submitDataRole = await accountingOracle.SUBMIT_DATA_ROLE();
        const submitDataRoleStatus = await accountingOracle.hasRole(submitDataRole, signer.address);
        if(!managementRoleStatus && !submitDataRoleStatus){
            await hashConsensus.connect(agentSigner).grantRole(managementRole, agentSigner);
            console.log(`${agentSigner.address} granted MANAGE_MEMBERS_AND_QUORUM_ROLE`);
            await accountingOracle.connect(agentSigner).grantRole(submitDataRole, signer.address);
            console.log(`${signer.address} granted SUBMIT_DATA_ROLE`);
        }
        // let quorum = await hashConsensus.getQuorum();
        // let committeMembers = await hashConsensus.getMembers(); 
        // const initialMemberCount = committeMembers[0].length;
        // for(let i = initialMemberCount; i > 1 ; i--){
        //     quorum = await hashConsensus.getQuorum();
        //     committeMembers = await hashConsensus.getMembers(); 
        //     await hashConsensus.connect(agentSigner).removeMember(committeMembers[0][0], Number(quorum) - 1);
        //     console.log(`${committeMembers[0][0]} removed as oracle committee member`);
        // }
        const committeMembers = await hashConsensus.getMembers();
        const signerisAlreadyMember: boolean = committeMembers[0].includes(signer.address);
        if(!signerisAlreadyMember){
            await hashConsensus.connect(agentSigner).addMember(signer.address, 1);
        }
        console.log(`${signer.address} is an oracle committee member`);
        console.log("Oracle Committee Member(s): ", await hashConsensus.getMembers());
        console.log("Fast Lane Comittee Member(s)", await hashConsensus.getFastLaneMembers());
        const { refSlot } = await hashConsensus.getCurrentFrame();
        console.log(await hashConsensus.getCurrentFrame());
        const oracleVersion = await accountingOracle.getContractVersion();
        const consensusVersion = await accountingOracle.getConsensusVersion();
        const count = await nor.getNodeOperatorsCount()
        console.log("Node Operators Count:", count);
        let temp = 0;
        for (let i = 0; i < count; i++){
            temp = Number((await nor.getNodeOperator(1, false)).totalVettedValidators) + temp;   
        }
        console.log("Vetted Validators:", temp);
        // let reportFields: OracleReport & { refSlot: bigint };
        const elRewardsVaultBalance = await lido.getTotalELRewardsCollected();
        const withdrawalVaultBalance = await ethers.provider.getBalance(lido.address) - elRewardsVaultBalance
        const reportFields = {
            consensusVersion: consensusVersion,// 1n,
            refSlot: refSlot,
            numValidators: 1,
            clBalanceGwei: 32 * 1e9,
            stakingModuleIdsWithNewlyExitedValidators: [],
            numExitedValidatorsByStakingModule: [],
            withdrawalVaultBalance: withdrawalVaultBalance,
            elRewardsVaultBalance: elRewardsVaultBalance,
            sharesRequestedToBurn: 0,
            withdrawalFinalizationBatches: [],
            simulatedShareRate: shareRate(1n),
            isBunkerMode: false,
            extraDataFormat: 0n,
            extraDataHash: ethers.ZeroHash,
            extraDataItemsCount: 0n,
          }
        const reportItems = getReportDataItems(reportFields);
        const reportHash = calcReportDataHash(reportItems);
        console.log("Reference Slot:", refSlot, await accountingOracle.getLastProcessingRefSlot());
        console.log("Member Consensus State:", await hashConsensus.getConsensusStateForMember(signer.address));
        console.log("Processing State:", await accountingOracle.getProcessingState());
        const submitReportTx = await hashConsensus.connect(signer).submitReport(refSlot, reportHash, consensusVersion)
        let tx = await submitReportTx.wait(); 
        console.log("Submit Report (Hash Consensus) Transaction:", tx);
        const submitReportDataTx = await accountingOracle.connect(signer).submitReportData(reportFields, oracleVersion);
        tx = await submitReportDataTx.wait();
        console.log("Submit Report Date (Accounting Oracle) Transaction:", tx);

    }
    catch(err){
        const decodedError = await errorDecoder.decode(err)
        console.log("Decoded Error:", decodedError);
    }
    // let reportFields: OracleReport & { refSlot: bigint };
}

export async function main() {
    const ctx: ProtocolContext = await getProtocolContext();
    const { lido } = ctx.contracts;
    const [signers] = await ethers.getSigners();
    await initializeProtocol();
    await stakeEther();
    console.log("stETH Balance after staking:", await lido.balanceOf(signers.address))
    await depositEther();
    await topUpLido()
    await distributeRewards();
    console.log("stETH Balance after token rebasing:", await lido.balanceOf(signers.address));
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});