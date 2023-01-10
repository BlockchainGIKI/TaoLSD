// SPDX-FileCopyrightText: 2021 Lido <info@lido.fi>

// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.8.9;

import {ECDSA} from "./lib/ECDSA.sol";
import {IStakingRouter} from "./interfaces/IStakingRouter.sol";
import {IDepositContract} from "./interfaces/IDepositContract.sol";

interface ILido {
    function deposit(
        uint256 _maxDepositsCount,
        uint24 _stakingModuleId,
        bytes calldata _depositCalldata
    ) external;
}

contract DepositSecurityModule {
    /**
     * Short ECDSA signature as defined in https://eips.ethereum.org/EIPS/eip-2098.
     */
    struct Signature {
        bytes32 r;
        bytes32 vs;
    }

    event OwnerChanged(address newValue);
    event PauseIntentValidityPeriodBlocksChanged(uint256 newValue);
    event MaxDepositsChanged(uint256 newValue);
    event MinDepositBlockDistanceChanged(uint256 newValue);
    event GuardianQuorumChanged(uint256 newValue);
    event GuardianAdded(address guardian);
    event GuardianRemoved(address guardian);
    event DepositsPaused(address indexed guardian, uint24 indexed stakingModuleId);
    event DepositsUnpaused(uint24 indexed stakingModuleId);

    bytes32 public immutable ATTEST_MESSAGE_PREFIX;
    bytes32 public immutable PAUSE_MESSAGE_PREFIX;

    ILido public immutable LIDO;
    IStakingRouter public immutable STAKING_ROUTER;
    IDepositContract public immutable DEPOSIT_CONTRACT;

    uint256 internal maxDepositsPerBlock;
    uint256 internal minDepositBlockDistance;
    uint256 internal pauseIntentValidityPeriodBlocks;

    address internal owner;

    uint256 internal quorum;
    address[] internal guardians;
    mapping(address => uint256) internal guardianIndicesOneBased; // 1-based

    constructor(
        address _lido,
        address _depositContract,
        address _stakingRouter,
        uint256 _maxDepositsPerBlock,
        uint256 _minDepositBlockDistance,
        uint256 _pauseIntentValidityPeriodBlocks
    ) {
        require(_lido != address(0), "LIDO_CONTRACT_ZERO_ADDRESS");
        require(_stakingRouter != address(0), "STAKING_ROUTER_ZERO_ADDRESS");
        require(_depositContract != address(0), "DEPOSIT_CONTRACT_ZERO_ADDRESS");

        LIDO = ILido(_lido);
        STAKING_ROUTER = IStakingRouter(_stakingRouter);
        DEPOSIT_CONTRACT = IDepositContract(_depositContract);

        ATTEST_MESSAGE_PREFIX = keccak256(
            abi.encodePacked(
                // keccak256("lido.DepositSecurityModule.ATTEST_MESSAGE")
                bytes32(0x1085395a994e25b1b3d0ea7937b7395495fb405b31c7d22dbc3976a6bd01f2bf),
                block.chainid,
                address(this)
            )
        );

        PAUSE_MESSAGE_PREFIX = keccak256(
            abi.encodePacked(
                // keccak256("lido.DepositSecurityModule.PAUSE_MESSAGE")
                bytes32(0x9c4c40205558f12027f21204d6218b8006985b7a6359bcab15404bcc3e3fa122),
                block.chainid,
                address(this)
            )
        );

        _setOwner(msg.sender);
        _setMaxDeposits(_maxDepositsPerBlock);
        _setMinDepositBlockDistance(_minDepositBlockDistance);
        _setPauseIntentValidityPeriodBlocks(_pauseIntentValidityPeriodBlocks);
    }

    /**
     * Returns the owner address.
     */
    function getOwner() external view returns (address) {
        return owner;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "not an owner");
        _;
    }

    /**
     * Sets new owner. Only callable by the current owner.
     */
    function setOwner(address newValue) external onlyOwner {
        _setOwner(newValue);
    }

    function _setOwner(address newValue) internal {
        require(newValue != address(0), "invalid value for owner: must be different from zero address");
        owner = newValue;
        emit OwnerChanged(newValue);
    }

    /**
     * Returns current `pauseIntentValidityPeriodBlocks` contract parameter (see `pauseDeposits`).
     */
    function getPauseIntentValidityPeriodBlocks() external view returns (uint256) {
        return pauseIntentValidityPeriodBlocks;
    }

    /**
     * Sets `pauseIntentValidityPeriodBlocks`. Only callable by the owner.
     */
    function setPauseIntentValidityPeriodBlocks(uint256 newValue) external onlyOwner {
        _setPauseIntentValidityPeriodBlocks(newValue);
    }

    function _setPauseIntentValidityPeriodBlocks(uint256 newValue) internal {
        require(newValue > 0, "invalid value for pauseIntentValidityPeriodBlocks: must be greater then 0");
        pauseIntentValidityPeriodBlocks = newValue;
        emit PauseIntentValidityPeriodBlocksChanged(newValue);
    }

    /**
     * Returns `maxDepositsPerBlock` (see `depositBufferedEther`).
     */
    function getMaxDeposits() external view returns (uint256) {
        return maxDepositsPerBlock;
    }

    /**
     * Sets `maxDepositsPerBlock`. Only callable by the owner.
     */
    function setMaxDeposits(uint256 newValue) external onlyOwner {
        _setMaxDeposits(newValue);
    }

    function _setMaxDeposits(uint256 newValue) internal {
        maxDepositsPerBlock = newValue;
        emit MaxDepositsChanged(newValue);
    }

    /**
     * Returns `minDepositBlockDistance`  (see `depositBufferedEther`).
     */
    function getMinDepositBlockDistance() external view returns (uint256) {
        return minDepositBlockDistance;
    }

    /**
     * Sets `minDepositBlockDistance`. Only callable by the owner.
     */
    function setMinDepositBlockDistance(uint256 newValue) external onlyOwner {
        _setMinDepositBlockDistance(newValue);
    }

    function _setMinDepositBlockDistance(uint256 newValue) internal {
        require(newValue > 0, "invalid value for minDepositBlockDistance: must be greater then 0");
        if (newValue != minDepositBlockDistance) {
            minDepositBlockDistance = newValue;
            emit MinDepositBlockDistanceChanged(newValue);
        }
    }

    /**
     * Returns number of valid guardian signatures required to vet (depositRoot, keysOpIndex) pair.
     */
    function getGuardianQuorum() external view returns (uint256) {
        return quorum;
    }

    function setGuardianQuorum(uint256 newValue) external onlyOwner {
        _setGuardianQuorum(newValue);
    }

    function _setGuardianQuorum(uint256 newValue) internal {
        // we're intentionally allowing setting quorum value higher than the number of guardians
        quorum = newValue;
        emit GuardianQuorumChanged(newValue);
    }

    /**
     * Returns guardian committee member list.
     */
    function getGuardians() external view returns (address[] memory) {
        return guardians;
    }

    /**
     * Checks whether the given address is a guardian.
     */
    function isGuardian(address addr) external view returns (bool) {
        return _isGuardian(addr);
    }

    function _isGuardian(address addr) internal view returns (bool) {
        return guardianIndicesOneBased[addr] > 0;
    }

    /**
     * Returns index of the guardian, or -1 if the address is not a guardian.
     */
    function getGuardianIndex(address addr) external view returns (int256) {
        return _getGuardianIndex(addr);
    }

    function _getGuardianIndex(address addr) internal view returns (int256) {
        return int256(guardianIndicesOneBased[addr]) - 1;
    }

    /**
     * Adds a guardian address and sets a new quorum value.
     * Reverts if the address is already a guardian.
     *
     * Only callable by the owner.
     */
    function addGuardian(address addr, uint256 newQuorum) external onlyOwner {
        _addGuardian(addr);
        _setGuardianQuorum(newQuorum);
    }

    /**
     * Adds a set of guardian addresses and sets a new quorum value.
     * Reverts any of them is already a guardian.
     *
     * Only callable by the owner.
     */
    function addGuardians(address[] memory addresses, uint256 newQuorum) external onlyOwner {
        for (uint256 i = 0; i < addresses.length; ++i) {
            _addGuardian(addresses[i]);
        }
        _setGuardianQuorum(newQuorum);
    }

    function _addGuardian(address addr) internal {
        require(addr != address(0), "guardian zero address");
        require(!_isGuardian(addr), "duplicate address");
        guardians.push(addr);
        guardianIndicesOneBased[addr] = guardians.length;
        emit GuardianAdded(addr);
    }

    /**
     * Removes a guardian with the given address and sets a new quorum value.
     *
     * Only callable by the owner.
     */
    function removeGuardian(address addr, uint256 newQuorum) external onlyOwner {
        uint256 indexOneBased = guardianIndicesOneBased[addr];
        require(indexOneBased != 0, "not a guardian");

        uint256 totalGuardians = guardians.length;
        assert(indexOneBased <= totalGuardians);

        if (indexOneBased != totalGuardians) {
            address addrToMove = guardians[totalGuardians - 1];
            guardians[indexOneBased - 1] = addrToMove;
            guardianIndicesOneBased[addrToMove] = indexOneBased;
        }

        guardianIndicesOneBased[addr] = 0;
        guardians.pop();

        _setGuardianQuorum(newQuorum);

        emit GuardianRemoved(addr);
    }

    /**
     * Pauses deposits for module given that both conditions are satisfied (reverts otherwise):
     *
     *   1. The function is called by the guardian with index guardianIndex OR sig
     *      is a valid signature by the guardian with index guardianIndex of the data
     *      defined below.
     *
     *   2. block.number - blockNumber <= pauseIntentValidityPeriodBlocks
     *
     * The signature, if present, must be produced for keccak256 hash of the following
     * message (each component taking 32 bytes):
     *
     * | PAUSE_MESSAGE_PREFIX | blockNumber | stakingModuleId |
     */
    function pauseDeposits(
        uint256 blockNumber,
        uint24 stakingModuleId,
        Signature memory sig
    ) external {
        // In case of an emergency function `pauseDeposits` is supposed to be called
        // by all guardians. Thus only the first call will do the actual change. But
        // the other calls would be OK operations from the point of view of protocol’s logic.
        // Thus we prefer not to use “error” semantics which is implied by `require`.

        /// @dev pause only active modules (not already paused, nor full stopped)
        if (!STAKING_ROUTER.getStakingModuleIsActive(stakingModuleId)) {
            return;
        }

        address guardianAddr = msg.sender;
        int256 guardianIndex = _getGuardianIndex(msg.sender);

        if (guardianIndex == -1) {
            bytes32 msgHash = keccak256(abi.encodePacked(PAUSE_MESSAGE_PREFIX, blockNumber, stakingModuleId));
            guardianAddr = ECDSA.recover(msgHash, sig.r, sig.vs);
            guardianIndex = _getGuardianIndex(guardianAddr);
            require(guardianIndex != -1, "invalid signature");
        }

        require(block.number - blockNumber <= pauseIntentValidityPeriodBlocks, "pause intent expired");

        STAKING_ROUTER.pauseStakingModule(stakingModuleId);
        emit DepositsPaused(guardianAddr, stakingModuleId);
    }

    /**
     * Unpauses deposits for module
     *
     * Only callable by the owner.
     */
    function unpauseDeposits(uint24 stakingModuleId) external onlyOwner {
         /// @dev unpause only paused modules (skip stopped)
        if (STAKING_ROUTER.getStakingModuleIsDepositsPaused(stakingModuleId)) {
            STAKING_ROUTER.resumeStakingModule(stakingModuleId);
            emit DepositsUnpaused(stakingModuleId);
        }
    }

    /**
     * Returns whether LIDO.deposit() can be called, given that the caller will provide
     * guardian attestations of non-stale deposit root and `keysOpIndex`, and the number of
     * such attestations will be enough to reach quorum.
     */
    function canDeposit(uint24 stakingModuleId) external view returns (bool) {
        bool isModuleActive = STAKING_ROUTER.getStakingModuleIsActive(stakingModuleId);
        uint256 lastDepositBlock = STAKING_ROUTER.getStakingModuleLastDepositBlock(stakingModuleId);
        return isModuleActive && quorum > 0 && block.number - lastDepositBlock >= minDepositBlockDistance;
    }

    /**
     * Calls LIDO.deposit(maxDepositsPerBlock, stakingModuleId, depositCalldata).
     *
     * Reverts if any of the following is true:
     *   1. IDepositContract.get_deposit_root() != depositRoot.
     *   2. StakingModule.getKeysOpIndex() != keysOpIndex.
     *   3. The number of guardian signatures is less than getGuardianQuorum().
     *   4. An invalid or non-guardian signature received.
     *   5. block.number - StakingModule.getLastDepositBlock() < minDepositBlockDistance.
     *   6. blockhash(blockNumber) != blockHash.
     *
     * Signatures must be sorted in ascending order by index of the guardian. Each signature must
     * be produced for keccak256 hash of the following message (each component taking 32 bytes):
     *
     * | ATTEST_MESSAGE_PREFIX | blockNumber | blockHash | depositRoot | stakingModuleId | keysOpIndex |
     */
    function depositBufferedEther(
        uint256 blockNumber,
        bytes32 blockHash,
        bytes32 depositRoot,
        uint24 stakingModuleId,
        uint256 keysOpIndex,
        bytes calldata depositCalldata,
        Signature[] calldata sortedGuardianSignatures
    ) external {
        require(quorum > 0 && sortedGuardianSignatures.length >= quorum, "no guardian quorum");

        bytes32 onchainDepositRoot = IDepositContract(DEPOSIT_CONTRACT).get_deposit_root();
        require(depositRoot == onchainDepositRoot, "deposit root changed");

        require(STAKING_ROUTER.getStakingModuleIsActive(stakingModuleId), "module not active");

        uint256 lastDepositBlock = STAKING_ROUTER.getStakingModuleLastDepositBlock(stakingModuleId);
        require(block.number - lastDepositBlock >= minDepositBlockDistance, "too frequent deposits");
        require(blockHash != bytes32(0) && blockhash(blockNumber) == blockHash, "unexpected block hash");

        uint256 onchainKeysOpIndex = STAKING_ROUTER.getStakingModuleKeysOpIndex(stakingModuleId);
        require(keysOpIndex == onchainKeysOpIndex, "keys op index changed");

        _verifySignatures(depositRoot, blockNumber, blockHash, stakingModuleId, keysOpIndex, sortedGuardianSignatures);

        LIDO.deposit(maxDepositsPerBlock, stakingModuleId, depositCalldata);
    }

    function _verifySignatures(
        bytes32 depositRoot,
        uint256 blockNumber,
        bytes32 blockHash,
        uint24 stakingModuleId,
        uint256 keysOpIndex,
        Signature[] memory sigs
    ) internal view {
        bytes32 msgHash = keccak256(
            abi.encodePacked(ATTEST_MESSAGE_PREFIX, blockNumber, blockHash, depositRoot, stakingModuleId, keysOpIndex)
        );

        address prevSignerAddr = address(0);

        for (uint256 i = 0; i < sigs.length; ++i) {
            address signerAddr = ECDSA.recover(msgHash, sigs[i].r, sigs[i].vs);
            require(_isGuardian(signerAddr), "invalid signature");
            require(signerAddr > prevSignerAddr, "signatures not sorted");
            prevSignerAddr = signerAddr;
        }
    }
}
