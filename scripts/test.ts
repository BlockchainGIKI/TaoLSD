import { ErrorDecoder } from 'ethers-decode-error'
import { artifacts,ethers } from "hardhat";

import { getProtocolContext, ProtocolContext } from "lib/protocol";

const HashConsensusArtifact = artifacts.readArtifactSync("HashConsensus");
const DepositSecurityModuleArtifact = artifacts.readArtifactSync("DepositSecurityModule");
const errorDecoder = ErrorDecoder.create([HashConsensusArtifact.abi, DepositSecurityModuleArtifact.abi]);
export async function main() {

    const ctx: ProtocolContext = await getProtocolContext();
    const address = "0x36C02dA8a0983159322a80FFE9F24b1acfF8B570";
    const HashConsensusContract = await ethers.getContractAt("HashConsensus", address);
    const DepositSecurityModule = await ethers.getContractAt("DepositSecurityModule", "0x8f86403A4DE0BB5791fa46B8e795C547942fE4Cf");
    const quorum = await HashConsensusContract.getQuorum();
    console.log("Quorum:", quorum.toString());
    const members = await HashConsensusContract.getMembers();
    console.log("Members:", members);
    const guardians = await DepositSecurityModule.getGuardians();
    console.log("Guardians:", guardians);
    // const data = HashConsensusContract.interface.encodeFunctionData("getQuorum");
    // const agentContract = await ethers.getContractAt("Agent", "0xc00c0beC9F5C6b245A5c232598b3A2cc1558C3c7");
    // const tx = await agentContract.execute(address, 0, data);
    // console.log("Agent Transaction:", tx);
    const agentSigner = await ctx.getSigner("agent");
    const HashConsensusWithAgent = HashConsensusContract.connect(agentSigner);
    const DepositSecurityModuleWithAgent = DepositSecurityModule.connect(agentSigner);
    try {
        // const tx = await HashConsensusWithAgent.removeMember("0x9e9CF59B410045151A4195B53fB960947CD6cD11", 5);
        // const tx = await HashConsensusWithAgent.updateInitialEpoch(12);
        const tx = await DepositSecurityModuleWithAgent.setOwner("0x8f86403A4DE0BB5791fa46B8e795C547942fE4Cf");
        const receipt = await tx.wait();
        console.log("Transaction Receipt:", receipt);
    } catch (err) {
        const decodedError = await errorDecoder.decode(err)
        console.log("Decoded Error:", decodedError);
      }
    // const tx = await HashConsensusContract.updateInitialEpoch(12);
    // console.log(agentSigner);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});