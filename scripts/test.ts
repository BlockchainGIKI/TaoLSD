import { ErrorDecoder } from 'ethers-decode-error'
import { artifacts, ethers } from "hardhat";

import { ether } from 'lib';
import { getProtocolContext, ProtocolContext } from "lib/protocol";

const HashConsensusArtifact = artifacts.readArtifactSync("HashConsensus");
const DepositSecurityModuleArtifact = artifacts.readArtifactSync("DepositSecurityModule");
const LidoArtifact = artifacts.readArtifactSync("Lido");
const WithdrawalQueueERC721Artifact = artifacts.readArtifactSync("WithdrawalQueueERC721");
const NodeOperatorsRegistryArtifact = artifacts.readArtifactSync("NodeOperatorsRegistry");
const errorDecoder = ErrorDecoder.create([HashConsensusArtifact.abi, DepositSecurityModuleArtifact.abi, LidoArtifact.abi, 
WithdrawalQueueERC721Artifact.abi, NodeOperatorsRegistryArtifact.abi
]);
const ZeroAddress: string = "0x0000000000000000000000000000000000000000";

async function initializeProtocol(){
    const ctx: ProtocolContext = await getProtocolContext();
    // Getting the accounts needed to execute functions
    const signers = await ethers.getSigners();
    const agentSigner = await ctx.getSigner("agent");
    // Getting contracts need to fully initialize the staking protocol
    // const HashConsensus = await ethers.getContractAt("HashConsensus", "0x36C02dA8a0983159322a80FFE9F24b1acfF8B570");
    // const DepositSecurityModule = await ethers.getContractAt("DepositSecurityModule", "0x8f86403A4DE0BB5791fa46B8e795C547942fE4Cf");
    // const Lido = await ethers.getContractAt("Lido", "0x59b670e9fA9D0A427751Af201D676719a970857b");
    // const WithdrawalQueueERC721 = await ethers.getContractAt("WithdrawalQueueERC721", "0xf5059a5D33d5853360D16C683c16e67980206f36");
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

async function depositEther(){
    const ctx: ProtocolContext = await getProtocolContext();
    // Getting the accounts needed to execute functions
    const signers = await ethers.getSigners();
    const agentSigner = await ctx.getSigner("agent");
    // Getting the Lido contract
    const {lido} = ctx.contracts;
    console.log("Can deposit", await lido.canDeposit());
    const deposit = ether("32.0");
    try{
    // const depositTx = await lido.connect(signers[0]).submit(ZeroAddress, { value: deposit });
    // console.log("Transaction Receipt:", depositTx);
    console.log("Buffered Ether:", await lido.getBufferedEther());
    } catch(err){
        const decodedError = await errorDecoder.decode(err)
        console.log("Decoded Error:", decodedError);
    }
}

export async function main() {
    // await initializeProtocol();
    // await depositEther();
    const ctx: ProtocolContext = await getProtocolContext();
    const{stakingRouter} = ctx.contracts;
    console.log("Staking Modules:", await stakingRouter.getStakingModules());
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});