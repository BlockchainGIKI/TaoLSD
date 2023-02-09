// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.8.9;

import "@openzeppelin/contracts-v4.4/utils/structs/EnumerableSet.sol";
import {UnstructuredStorage} from "./lib/UnstructuredStorage.sol";
import {UnstructuredRefStorage} from "./lib/UnstructuredRefStorage.sol";

/// @title Queue to store and manage WithdrawalRequests.
/// @dev Use an optimizations to store discounts heavily inspired
/// by Aragon MiniMe token https://github.com/aragon/aragon-minime/blob/master/contracts/MiniMeToken.sol
///
/// @author folkyatina
abstract contract WithdrawalQueueBase {
    using EnumerableSet for EnumerableSet.UintSet;
    using UnstructuredStorage for bytes32;

    /// @notice precision base for share rate and discounting factor values in the contract
    uint256 public constant E27_PRECISION_BASE = 1e27;

    /// @dev discount factor value that means no discount applying
    uint96 internal constant NO_DISCOUNT = uint96(E27_PRECISION_BASE);

    /// @dev return value for the `find...` methods in case of no result
    uint256 internal constant NOT_FOUND = 0;

    // queue for withdrawal requests, indexes (requestId) start from 1
    bytes32 internal constant QUEUE_POSITION = keccak256("lido.WithdrawalQueue.queue");
    // length of the queue
    bytes32 internal constant LAST_REQUEST_ID_POSITION = keccak256("lido.WithdrawalQueue.lastRequestId");
    // length of the finalized part of the queue. Always <= `requestCounter`
    bytes32 internal constant LAST_FINALIZED_REQUEST_ID_POSITION =
        keccak256("lido.WithdrawalQueue.lastFinalizedRequestId");
    /// finalization discount history, indexes start from 1
    bytes32 internal constant CHECKPOINTS_POSITION = keccak256("lido.WithdrawalQueue.checkpoints");
    /// length of the checkpoints
    bytes32 internal constant LAST_CHECKPOINT_INDEX_POSITION = keccak256("lido.WithdrawalQueue.lastCheckpointIndex");
    /// amount of eth locked on contract for withdrawal
    bytes32 internal constant LOCKED_ETHER_AMOUNT_POSITION = keccak256("lido.WithdrawalQueue.lockedEtherAmount");
    /// withdrawal requests mapped to the owners
    bytes32 internal constant REQUEST_BY_OWNER_POSITION = keccak256("lido.WithdrawalQueue.requestsByOwner");

    /// @notice structure representing a request for withdrawal.
    struct WithdrawalRequest {
        /// @notice sum of the all stETH submitted for withdrawals up to this request
        uint128 cumulativeStETH;
        /// @notice sum of the all shares locked for withdrawal up to this request
        uint128 cumulativeShares;
        /// @notice address that can claim or transfer the request
        address payable owner;
        /// @notice block.timestamp when the request was created
        uint64 timestamp;
        /// @notice flag if the request was claimed
        bool claimed;
    }

    /// @notice structure to store discount factors for requests in the queue
    struct DiscountCheckpoint {
        /// @notice first `_requestId` the discount is valid for
        uint256 fromRequestId;
        /// @notice discount factor with 1e27 precision (0 - 100% discount, 1e27 - means no discount)
        uint96 discountFactor;
    }

    /// @dev Contains both stETH token amount and its corresponding shares amount
    event WithdrawalRequested(
        uint256 indexed requestId,
        address indexed requestor,
        address indexed owner,
        uint256 amountOfStETH,
        uint256 amountOfShares
    );
    event WithdrawalBatchFinalized(
        uint256 indexed from, uint256 indexed to, uint256 amountOfETHLocked, uint256 sheresToBurn, uint256 timestamp
    );
    event WithdrawalClaimed(
        uint256 indexed requestId, address indexed owner, address indexed receiver, uint256 amountOfETH
    );

    error ZeroAmountOfETH();
    error ZeroShareRate();
    error ZeroTimestamp();
    error TooMuchEtherToFinalize(uint256 sent, uint256 maxExpected);
    error NotOwner(address _sender, address _owner);
    error InvalidRequestId(uint256 _requestId);
    error InvalidRequestIdRange(uint256 startId, uint256 endId);
    error NotEnoughEther();
    error RequestNotFinalized(uint256 _requestId);
    error RequestAlreadyClaimed(uint256 _requestId);
    error InvalidHint(uint256 _hint);
    error CantSendValueRecipientMayHaveReverted();

    /// @notice id of the last request, returns 0, if no request in the queue
    function getLastRequestId() public view returns (uint256) {
        return LAST_REQUEST_ID_POSITION.getStorageUint256();
    }

    /// @notice id of the last finalized request, returns 0 if no finalized requests in the queue
    function getLastFinalizedRequestId() public view returns (uint256) {
        return LAST_FINALIZED_REQUEST_ID_POSITION.getStorageUint256();
    }

    /// @notice amount of ETH on this contract balance that is locked for withdrawal and available to claim
    function getLockedEtherAmount() public view returns (uint256) {
        return LOCKED_ETHER_AMOUNT_POSITION.getStorageUint256();
    }

    /// @notice length of the checkpoints. Last possible value for the claim hint
    function getLastCheckpointIndex() public view returns (uint256) {
        return LAST_CHECKPOINT_INDEX_POSITION.getStorageUint256();
    }

    /// @notice return the number of unfinalized requests in the queue
    function unfinalizedRequestNumber() external view returns (uint256) {
        return getLastRequestId() - getLastFinalizedRequestId();
    }

    /// @notice Returns the amount of stETH in the queue yet to be finalized
    function unfinalizedStETH() external view returns (uint256) {
        return
            _getQueue()[getLastRequestId()].cumulativeStETH - _getQueue()[getLastFinalizedRequestId()].cumulativeStETH;
    }

    /// @notice Returns all withdrawal requests that belongs to the `_owner` address
    ///
    /// WARNING: This operation will copy the entire storage to memory, which can be quite expensive. This is designed
    /// to mostly be used by view accessors that are queried without any gas fees. Developers should keep in mind that
    /// this function has an unbounded cost, and using it as part of a state-changing function may render the function
    /// uncallable if the set grows to a point where copying to memory consumes too much gas to fit in a block.
    function getWithdrawalRequests(address _owner) external view returns (uint256[] memory requestsIds) {
        return _getRequestsByOwner()[_owner].values();
    }

    /// @notice output format struct for `getWithdrawalRequestStatus()`
    struct WithdrawalRequestStatus {
        /// @notice stETH token amount that was locked on withdrawal queue for this request
        uint256 amountOfStETH;
        /// @notice amount of stETH shares locked on withdrawal queue for this request
        uint256 amountOfShares;
        /// @notice address that can claim or transfer this request
        address owner;
        /// @notice timestamp of when the request was created, in seconds
        uint256 timestamp;
        /// @notice true, if request is finalized
        bool isFinalized;
        /// @notice true, if request is claimed. Request is claimable if (isFinalized && !isClaimed)
        bool isClaimed;
    }

    /// @notice Returns status of the withdrawal request with `_requestId` id
    function getWithdrawalRequestStatus(uint256 _requestId)
        public
        view
        returns (WithdrawalRequestStatus memory status)
    {
        if (_requestId == 0 || _requestId > getLastRequestId()) revert InvalidRequestId(_requestId);

        WithdrawalRequest memory request = _getQueue()[_requestId];
        WithdrawalRequest memory previousRequest = _getQueue()[_requestId - 1];

        status = WithdrawalRequestStatus(
            request.cumulativeStETH - previousRequest.cumulativeStETH,
            request.cumulativeShares - previousRequest.cumulativeShares,
            request.owner,
            request.timestamp,
            _requestId <= getLastFinalizedRequestId(),
            request.claimed
        );
    }

    /// @notice View function to find a hint to pass it to `claimWithdrawal()`.
    /// @dev WARNING! OOG is possible if used onchain, contains unbounded loop inside
    /// See `findCheckpointHint(uint256 _requestId, uint256 _firstIndex, uint256 _lastIndex)` for onchain use
    /// @param _requestId request id to be claimed with this hint
    function findCheckpointHintUnbounded(uint256 _requestId) public view returns (uint256) {
        return findCheckpointHint(_requestId, 1, getLastCheckpointIndex());
    }

    /// @notice View function to find a checkpoint hint for `claimWithdrawal()`
    ///  Search will be performed in the range of `[_firstIndex, _lastIndex]`
    ///
    /// NB!: Range search ought to be used to optimize gas cost.
    /// You can utilize the following invariant:
    /// `if (requestId2 > requestId1) than hint2 >= hint1`,
    /// so you can search for `hint2` in the range starting from `hint1`
    ///
    /// @param _requestId request id we are searching the checkpoint for
    /// @param _start index of the left boundary of the search range
    /// @param _end index of the right boundary of the search range
    ///
    /// @return value that hints `claimWithdrawal` to find the discount for the request,
    ///  or 0 if hint not found in the range
    function findCheckpointHint(uint256 _requestId, uint256 _start, uint256 _end) public view returns (uint256) {
        if (_requestId == 0) revert InvalidRequestId(_requestId);
        if (_start == 0) revert InvalidRequestIdRange(_start, _end);
        uint256 lastCheckpointIndex = getLastCheckpointIndex();
        if (_end > lastCheckpointIndex) revert InvalidRequestIdRange(_start, _end);
        if (_requestId > getLastFinalizedRequestId()) revert RequestNotFinalized(_requestId);

        if (_start > _end) return NOT_FOUND; // we have an empty range to search in, so return NOT_FOUND

        // Right boundary
        if (_requestId >= _getCheckpoints()[_end].fromRequestId) {
            // it's the last checkpoint, so it's valid
            if (_end == lastCheckpointIndex) return _end;
            // it fits right before the next checkpoint
            if (_requestId < _getCheckpoints()[_end + 1].fromRequestId) return _end;

            return NOT_FOUND;
        }
        // Left boundary
        if (_requestId < _getCheckpoints()[_start].fromRequestId) {
            return NOT_FOUND;
        }

        // Binary search
        uint256 min = _start;
        uint256 max = _end;

        while (max > min) {
            uint256 mid = (max + min + 1) / 2;
            if (_getCheckpoints()[mid].fromRequestId <= _requestId) {
                min = mid;
            } else {
                max = mid - 1;
            }
        }
        return min;
    }

    /// @notice Search for the latest request in the queue in the range of `[startId, endId]`,
    ///  that has `request.timestamp <= maxTimestamp`
    ///
    /// @return finalizableRequestId or 0, if there are no requests in a range with requested timestamp
    function findLastFinalizableRequestIdByTimestamp(uint256 _maxTimestamp, uint256 _startId, uint256 _endId)
        public
        view
        returns (uint256 finalizableRequestId)
    {
        if (_maxTimestamp == 0) revert ZeroTimestamp();
        if (_startId <= getLastFinalizedRequestId() || _endId > getLastRequestId()) {
            revert InvalidRequestIdRange(_startId, _endId);
        } 

        if (_startId > _endId) return NOT_FOUND; // we have an empty range to search in

        uint256 min = _startId;
        uint256 max = _endId;

        finalizableRequestId = NOT_FOUND;

        while (min <= max) {
            uint256 mid = (max + min) / 2;
            if (_getQueue()[mid].timestamp <= _maxTimestamp) {
                finalizableRequestId = mid;

                // Ignore left half
                min = mid + 1;
            } else {
                // Ignore right half
                max = mid - 1;
            }
        }
    }

    /// @notice Search for the latest request in the queue in the range of `[startId, endId]`,
    ///  that can be finalized within the given `_ethBudget` by `_shareRate`
    /// @param _ethBudget amount of ether available for withdrawal fulfillment
    /// @param _shareRate share/ETH rate that will be used for fulfillment
    /// @param _startId requestId to start search from. Should be > lastFinalizedRequestId
    /// @param _endId requestId to search upon to. Should be <= lastRequestId
    ///
    /// @return finalizableRequestId or 0, if there are no requests finalizable within the given `_ethBudget`
    function findLastFinalizableRequestIdByBudget(
        uint256 _ethBudget,
        uint256 _shareRate,
        uint256 _startId,
        uint256 _endId
    ) public view returns (uint256 finalizableRequestId) {
        if (_ethBudget == 0) revert ZeroAmountOfETH();
        if (_shareRate == 0) revert ZeroShareRate();
        if (_startId <= getLastFinalizedRequestId() || _endId > getLastRequestId()) {
            revert InvalidRequestIdRange(_startId, _endId);
        } 

        if (_startId > _endId) return NOT_FOUND; // we have an empty range to search in

        uint256 min = _startId;
        uint256 max = _endId;

        finalizableRequestId = NOT_FOUND;

        while (min <= max) {
            uint256 mid = (max + min) / 2;
            (uint256 requiredEth,) = finalizationBatch(mid, _shareRate);

            if (requiredEth <= _ethBudget) {
                finalizableRequestId = mid;

                // Ignore left half
                min = mid + 1;
            } else {
                // Ignore right half
                max = mid - 1;
            }
        }
    }

    /// @notice Returns last `requestId` finalizable under given conditions
    /// @param _ethBudget max amount of eth to be used for finalization
    /// @param _shareRate share rate that will be applied to requests
    /// @param _maxTimestamp timestamp that requests should be created before
    ///
    /// @dev WARNING! OOG is possible if used onchain, contains unbounded loop inside
    /// @return finalizableRequestId or 0, if there are no requests finalizable under given conditions
    function findLastFinalizableRequestId(uint256 _ethBudget, uint256 _shareRate, uint256 _maxTimestamp)
        external
        view
        returns (uint256 finalizableRequestId)
    {
        uint256 firstUnfinalizedRequestId = getLastFinalizedRequestId() + 1;
        finalizableRequestId =
            findLastFinalizableRequestIdByBudget(_ethBudget, _shareRate, firstUnfinalizedRequestId, getLastRequestId());
        return findLastFinalizableRequestIdByTimestamp(_maxTimestamp, firstUnfinalizedRequestId, finalizableRequestId);
    }

    /// @notice Calculates the amount of ETH required to finalize the batch of requests in the queue up to
    /// `_nextFinalizedRequestId` with given `_shareRate` and the amount of shares that should be burned after
    /// @param _nextFinalizedRequestId id of the ending request in the finalization batch (>0 and <=lastRequestId)
    /// @param _shareRate share rate that will be used to calculate the batch (1e27 precision, >0)
    ///
    /// @return ethToLock amount of ETH required to finalize the batch
    /// @return sharesToBurn amount of shares that should be burned after the finalization
    function finalizationBatch(uint256 _nextFinalizedRequestId, uint256 _shareRate)
        public
        view
        returns (uint256 ethToLock, uint256 sharesToBurn)
    {
        if (_shareRate == 0) revert ZeroShareRate();
        if (_nextFinalizedRequestId > getLastRequestId()) revert InvalidRequestId(_nextFinalizedRequestId);
        uint256 lastFinalizedRequestId = getLastFinalizedRequestId();
        if (_nextFinalizedRequestId <= lastFinalizedRequestId) revert InvalidRequestId(_nextFinalizedRequestId);

        WithdrawalRequest memory requestToFinalize = _getQueue()[_nextFinalizedRequestId];
        WithdrawalRequest memory lastFinalizedRequest = _getQueue()[lastFinalizedRequestId];

        uint256 amountOfETHRequested = requestToFinalize.cumulativeStETH - lastFinalizedRequest.cumulativeStETH;
        uint256 amountOfShares = requestToFinalize.cumulativeShares - lastFinalizedRequest.cumulativeShares;

        ethToLock = amountOfETHRequested;
        sharesToBurn = amountOfShares;

        uint256 currentValueInETH = (amountOfShares * _shareRate) / E27_PRECISION_BASE;
        if (currentValueInETH < amountOfETHRequested) {
            ethToLock = currentValueInETH;
        }
    }

    /// @dev Finalize requests from last finalized one up to `_nextFinalizedRequestId`
    ///  Emits WithdrawalBatchFinalized event.
    function _finalize(uint256 _nextFinalizedRequestId, uint256 _amountOfETH) internal {
        if (_nextFinalizedRequestId > getLastRequestId()) revert InvalidRequestId(_nextFinalizedRequestId);
        uint256 lastFinalizedRequestId = getLastFinalizedRequestId();
        uint256 firstUnfinalizedRequestId = lastFinalizedRequestId + 1;
        if (_nextFinalizedRequestId <= lastFinalizedRequestId) revert InvalidRequestId(_nextFinalizedRequestId);

        WithdrawalRequest memory lastFinalizedRequest = _getQueue()[lastFinalizedRequestId];
        WithdrawalRequest memory requestToFinalize = _getQueue()[_nextFinalizedRequestId];

        uint128 stETHToFinalize = requestToFinalize.cumulativeStETH - lastFinalizedRequest.cumulativeStETH;
        if (_amountOfETH > stETHToFinalize) revert TooMuchEtherToFinalize(_amountOfETH, stETHToFinalize);

        uint256 discountFactor = NO_DISCOUNT;
        if (stETHToFinalize > _amountOfETH) {
            discountFactor = _amountOfETH * E27_PRECISION_BASE / stETHToFinalize;
        }

        uint256 lastCheckpointIndex = getLastCheckpointIndex();
        DiscountCheckpoint storage lastCheckpoint = _getCheckpoints()[lastCheckpointIndex];

        if (discountFactor != lastCheckpoint.discountFactor) {
            // add a new discount if it differs from the previous
            _getCheckpoints()[lastCheckpointIndex + 1] =
                DiscountCheckpoint(firstUnfinalizedRequestId, uint96(discountFactor));
            _setLastCheckpointIndex(lastCheckpointIndex + 1);
        }

        _setLockedEtherAmount(getLockedEtherAmount() + _amountOfETH);
        _setLastFinalizedRequestId(_nextFinalizedRequestId);

        emit WithdrawalBatchFinalized(
            firstUnfinalizedRequestId,
            _nextFinalizedRequestId,
            _amountOfETH,
            requestToFinalize.cumulativeShares - lastFinalizedRequest.cumulativeShares,
            block.timestamp
        );
    }

    /// @dev creates a new `WithdrawalRequest` in the queue
    ///  Emits WithdrawalRequested event
    /// Does not check parameters
    function _enqueue(uint128 _amountOfStETH, uint128 _amountOfShares, address _owner)
        internal
        returns (uint256 requestId)
    {
        uint256 lastRequestId = getLastRequestId();
        WithdrawalRequest memory lastRequest = _getQueue()[lastRequestId];

        uint128 cumulativeShares = lastRequest.cumulativeShares + _amountOfShares;
        uint128 cumulativeStETH = lastRequest.cumulativeStETH + _amountOfStETH;

        requestId = lastRequestId + 1;

        _setLastRequestId(requestId);
        _getQueue()[requestId] =
            WithdrawalRequest(cumulativeStETH, cumulativeShares, payable(_owner), uint64(block.timestamp), false);
        _getRequestsByOwner()[_owner].add(requestId);

        emit WithdrawalRequested(requestId, msg.sender, _owner, _amountOfStETH, _amountOfShares);
    }

    /// @notice Claim `_requestId` request and transfer related ether to the `_recipient`. Emits WithdrawalClaimed event
    /// @param _requestId request id to claim
    /// @param _hint hint for discount checkpoint index to avoid extensive search over the checkpoints.
    ///  Can be found with `findCheckpointHint()` or `findCheckpointHintUnbounded()`
    /// @param _recipient address to send ether to. If `==address(0)` then will send to the owner.
    function _claimWithdrawalTo(uint256 _requestId, uint256 _hint, address _recipient) internal {
        if (_hint == 0) revert InvalidHint(_hint);

        if (_requestId > getLastFinalizedRequestId()) revert RequestNotFinalized(_requestId);
        uint256 lastCheckpointIndex = getLastCheckpointIndex();
        if (_hint > lastCheckpointIndex) revert InvalidHint(_hint);

        WithdrawalRequest storage request = _getQueue()[_requestId];
        if (request.claimed) revert RequestAlreadyClaimed(_requestId);
        if (msg.sender != request.owner) revert NotOwner(msg.sender, request.owner);
        if (_recipient == address(0)) _recipient = request.owner;

        request.claimed = true;

        DiscountCheckpoint memory hintCheckpoint = _getCheckpoints()[_hint];
        // ______(_______
        //    ^  hint
        if (_requestId < hintCheckpoint.fromRequestId) revert InvalidHint(_hint);
        if (_hint < lastCheckpointIndex) {
            // ______(_______(_________
            //       hint    hint+1  ^
            DiscountCheckpoint memory nextCheckpoint = _getCheckpoints()[_hint + 1];
            if (nextCheckpoint.fromRequestId <= _requestId) {
                revert InvalidHint(_hint);
            }
        }

        uint256 ethRequested = request.cumulativeStETH - _getQueue()[_requestId - 1].cumulativeStETH;
        uint256 ethWithDiscount = ethRequested * hintCheckpoint.discountFactor / E27_PRECISION_BASE;

        _setLockedEtherAmount(getLockedEtherAmount() - ethWithDiscount);

        _sendValue(payable(_recipient), ethWithDiscount);

        emit WithdrawalClaimed(_requestId, msg.sender, _recipient, ethWithDiscount);
    }

    // quazi-constructor
    function _initializeQueue() internal {
        // setting dummy zero structs in checkpoints and queue beginning
        // to avoid uint underflows and related if-branches
        // 0-index is reserved as 'not_found' response in the interface everywhere
        _getQueue()[0] = WithdrawalRequest(0, 0, payable(0), uint64(block.number), true);
        _getCheckpoints()[getLastCheckpointIndex()] = DiscountCheckpoint(0, 0);
    }

    function _sendValue(address payable _recipient, uint256 _amount) internal {
        if (address(this).balance < _amount) revert NotEnoughEther();

        // solhint-disable-next-line
        (bool success,) = _recipient.call{value: _amount}("");
        if (!success) revert CantSendValueRecipientMayHaveReverted();
    }

    //
    // Internal getters and setters
    //
    function _getQueue() internal pure returns (mapping(uint256 => WithdrawalRequest) storage queue) {
        bytes32 position = QUEUE_POSITION;
        assembly {
            queue.slot := position
        }
    }

    function _getCheckpoints() internal pure returns (mapping(uint256 => DiscountCheckpoint) storage checkpoints) {
        bytes32 position = CHECKPOINTS_POSITION;
        assembly {
            checkpoints.slot := position
        }
    }

    function _getRequestsByOwner()
        internal
        pure
        returns (mapping(address => EnumerableSet.UintSet) storage requestsByOwner)
    {
        bytes32 position = REQUEST_BY_OWNER_POSITION;
        assembly {
            requestsByOwner.slot := position
        }
    }

    function _setLastRequestId(uint256 _lastRequestId) internal {
        LAST_REQUEST_ID_POSITION.setStorageUint256(_lastRequestId);
    }

    function _setLastFinalizedRequestId(uint256 _lastFinalizedRequestId) internal {
        LAST_FINALIZED_REQUEST_ID_POSITION.setStorageUint256(_lastFinalizedRequestId);
    }

    function _setLastCheckpointIndex(uint256 _lastCheckpointIndex) internal {
        LAST_CHECKPOINT_INDEX_POSITION.setStorageUint256(_lastCheckpointIndex);
    }

    function _setLockedEtherAmount(uint256 _lockedEtherAmount) internal {
        LOCKED_ETHER_AMOUNT_POSITION.setStorageUint256(_lockedEtherAmount);
    }
}
