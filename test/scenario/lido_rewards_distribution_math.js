const { assert } = require('chai')
const { BN } = require('bn.js')
const { assertBn, assertEvent } = require('@aragon/contract-helpers-test/src/asserts')
const { getEventArgument, ZERO_ADDRESS } = require('@aragon/contract-helpers-test')

const { pad, ETH } = require('../helpers/utils')
const { deployDaoAndPool } = require('./helpers/deploy')
const { DSMAttestMessage, DSMPauseMessage } = require('../0.8.9/helpers/signatures')

const INodeOperatorsRegistry = artifacts.require('INodeOperatorsRegistry')

const tenKBN = new BN(10000)

// Fee and its distribution are in basis points, 10000 corresponding to 100%

// Total max fee is 10%
const totalFeePoints = 0.1 * 10000

// Of this 1%, 30% goes to the treasury
const treasuryFeePoints = 0.3 * 10000
// 50% goes to node operators
const nodeOperatorsFeePoints = 0.7 * 10000

contract('Lido: rewards distribution math', (addresses) => {
  const [
    // the root account which deployed the DAO
    appManager,
    // the address which we use to simulate the voting DAO application
    voting,
    // node operators
    operator_1,
    operator_2,
    // users who deposit Ether to the pool
    user1,
    user2,
    // unrelated address
    nobody
  ] = addresses

  let pool, nodeOperatorsRegistry, token
  let stakingRouter
  let oracleMock
  let treasuryAddr, guardians
  let depositSecurityModule, depositRoot

  // Each node operator has its Ethereum 1 address, a name and a set of registered
  // validators, each of them defined as a (public key, signature) pair
  const nodeOperator1 = {
    name: 'operator_1',
    address: operator_1,
    validators: [
      {
        key: pad('0x010101', 48),
        sig: pad('0x01', 96)
      },
      {
        key: pad('0x030303', 48),
        sig: pad('0x03', 96)
      }
    ]
  }

  const nodeOperator2 = {
    name: 'operator_2',
    address: operator_2,
    validators: [
      {
        key: pad('0x020202', 48),
        sig: pad('0x02', 96)
      }
    ]
  }

  var epoch = 100

  function reportBeacon(validatorsCount, balance) {
    return oracleMock.reportBeacon(epoch++, validatorsCount, balance)
  }

  before(async () => {
    const deployed = await deployDaoAndPool(appManager, voting)

    // contracts/StETH.sol
    token = deployed.pool

    // contracts/Lido.sol
    pool = deployed.pool
    await pool.resumeProtocolAndStaking()

    // contracts/nos/NodeOperatorsRegistry.sol
    nodeOperatorsRegistry = deployed.nodeOperatorsRegistry

    // contracts/0.8.9/StakingRouter.sol
    stakingRouter = deployed.stakingRouter

    // mocks
    oracleMock = deployed.oracleMock

    // addresses
    treasuryAddr = deployed.treasuryAddr
    depositSecurityModule = deployed.depositSecurityModule
    guardians = deployed.guardians

    depositRoot = await deployed.depositContractMock.get_deposit_root()

    await stakingRouter.setWithdrawalCredentials(withdrawalCredentials, { from: voting })
  })

  it(`initial treasury balance is zero`, async () => {
    assertBn(await token.balanceOf(treasuryAddr), new BN(0), 'treasury balance is zero')
  })

  it(`registers one node operator with one key`, async () => {
    const txn = await nodeOperatorsRegistry.addNodeOperator(nodeOperator1.name, nodeOperator1.address, { from: voting })

    // Some Truffle versions fail to decode logs here, so we're decoding them explicitly using a helper
    nodeOperator1.id = getEventArgument(txn, 'NodeOperatorAdded', 'id', { decodeForAbi: INodeOperatorsRegistry._json.abi })
    assertBn(nodeOperator1.id, 0, 'operator id')

    assertBn(await nodeOperatorsRegistry.getNodeOperatorsCount(), 1, 'total node operators')
    await nodeOperatorsRegistry.addSigningKeysOperatorBH(
      nodeOperator1.id,
      1,
      nodeOperator1.validators[0].key,
      nodeOperator1.validators[0].sig,
      {
        from: nodeOperator1.address
      }
    )

    const totalKeys = await nodeOperatorsRegistry.getTotalSigningKeyCount(nodeOperator1.id, { from: nobody })
    assertBn(totalKeys, 1, 'total signing keys')

    const unusedKeys = await nodeOperatorsRegistry.getUnusedSigningKeyCount(nodeOperator1.id, { from: nobody })
    assertBn(unusedKeys, 1, 'unused signing keys')

    assertBn(await token.balanceOf(nodeOperator1.address), new BN(0), 'nodeOperator1 balance is zero')

    await nodeOperatorsRegistry.setNodeOperatorStakingLimit(nodeOperator1.id, 1, { from: voting })

    const ether2Stat = await pool.getBeaconStat()
    assertBn(ether2Stat.depositedValidators, 0, 'no validators have received the ether2')
    assertBn(ether2Stat.beaconBalance, 0, 'remote ether2 not reported yet')
  })

  it(`registers submit correctly`, async () => {
    const depostitEthValue = 34
    const depositAmount = ETH(depostitEthValue)

    const receipt = await pool.submit(ZERO_ADDRESS, { value: depositAmount, from: user1 })

    assertEvent(receipt, 'Transfer', { expectedArgs: { from: 0, to: user1, value: depositAmount } })

    const ether2Stat = await pool.getBeaconStat()
    assertBn(ether2Stat.depositedValidators, 0, 'one validator have received the ether2')
    assertBn(ether2Stat.beaconBalance, 0, `no remote ether2 on validator's balance is reported yet`)

    assertBn(await pool.getBufferedEther(), ETH(depostitEthValue), `all the ether is buffered until deposit`)
    assertBn(await pool.getTotalPooledEther(), depositAmount, 'total pooled ether')

    // The amount of tokens corresponding to the deposited ETH value was minted to the user

    assertBn(await token.balanceOf(user1), depositAmount, 'user1 tokens')

    assertBn(await token.totalSupply(), depositAmount, 'token total supply')
    // Total shares are equal to deposited eth before ratio change and fee mint
    assertBn(await token.getTotalShares(), depositAmount, 'total shares')

    assertBn(await token.balanceOf(treasuryAddr), new BN(0), 'treasury balance is zero')
    assertBn(await token.balanceOf(nodeOperator1.address), new BN(0), 'nodeOperator1 balance is zero')
  })

  it(`the first deposit gets deployed`, async () => {
    const [curated] = await stakingRouter.getStakingModules()

    const block = await web3.eth.getBlock('latest')
    const keysOpIndex = await nodeOperatorsRegistry.getKeysOpIndex()

    DSMAttestMessage.setMessagePrefix(await depositSecurityModule.ATTEST_MESSAGE_PREFIX())
    DSMPauseMessage.setMessagePrefix(await depositSecurityModule.PAUSE_MESSAGE_PREFIX())

    const validAttestMessage = new DSMAttestMessage(block.number, block.hash, depositRoot, curated.id, keysOpIndex)

    const signatures = [
      validAttestMessage.sign(guardians.privateKeys[guardians.addresses[0]]),
      validAttestMessage.sign(guardians.privateKeys[guardians.addresses[1]])
    ]

    await depositSecurityModule.depositBufferedEther(block.number, block.hash, depositRoot, curated.id, keysOpIndex, '0x', signatures)

    assertBn(await nodeOperatorsRegistry.getUnusedSigningKeyCount(0), 0, 'no more available keys for the first validator')
    assertBn(await token.balanceOf(user1), ETH(34), 'user1 balance is equal first reported value + their buffered deposit value')
    assertBn(await token.sharesOf(user1), ETH(34), 'user1 shares are equal to the first deposit')
    assertBn(await token.totalSupply(), ETH(34), 'token total supply')

    assertBn(await token.balanceOf(treasuryAddr), ETH(0), 'treasury balance equals buffered value')
    assertBn(await token.balanceOf(nodeOperator1.address), new BN(0), 'nodeOperator1 balance is zero')
  })

  it(`first report registers profit`, async () => {
    const profitAmountEth = 1
    const profitAmount = ETH(profitAmountEth)
    const reportingValue = ETH(32 + profitAmountEth)
    const prevTotalShares = await pool.getTotalShares()
    // for some reason there's nothing in this receipt's log, so we're not going to use it
    const [{ receipt }, deltas] = await getSharesTokenDeltas(
      () => reportBeacon(1, reportingValue),
      treasuryAddr,
      nodeOperatorsRegistry.address,
      user1
    )

    const [treasuryTokenDelta, treasurySharesDelta, nodeOperatorsRegistryTokenDelta, nodeOperatorsRegistrySharesDelta] = deltas

    const { reportedMintAmount, tos, values } = await readLastPoolEventLog()

    const {
      totalFeeToDistribute,
      nodeOperatorsSharesToMint,
      treasurySharesToMint,
      nodeOperatorsFeeToMint,
      treasuryFeeToMint
    } = await getAwaitedFeesSharesTokensDeltas(profitAmount, prevTotalShares, 1)

    assertBn(nodeOperatorsRegistrySharesDelta, nodeOperatorsSharesToMint, 'nodeOperator1 shares are correct')
    assertBn(treasurySharesDelta, treasurySharesToMint, 'treasury shares are correct')

    assertBn(treasuryFeeToMint.add(nodeOperatorsFeeToMint), reportedMintAmount, 'reported the expected total fee')

    assert.equal(tos[0], nodeOperatorsRegistry.address, 'second transfer to node operator')
    assertBn(values[0], nodeOperatorsFeeToMint, 'operator transfer amount is correct')
    assert.equal(tos[1], treasuryAddr, 'third transfer to treasury address')
    assertBn(values[1], treasuryFeeToMint, 'treasury transfer amount is correct')
    // URURU
    assertBn(
      await token.balanceOf(user1),
      // 32 staked 2 buffered 1 profit
      new BN(ETH(32 + 2 + 1)).sub(totalFeeToDistribute),
      'user1 balance is equal first reported value + their buffered deposit value'
    )
    assertBn(await token.sharesOf(user1), ETH(34), 'user1 shares are equal to the first deposit')
    assertBn(await token.totalSupply(), ETH(35), 'token total supply')

    assertBn(await token.balanceOf(treasuryAddr), treasuryFeeToMint, 'treasury balance = fee')
    assertBn(treasuryTokenDelta, treasuryFeeToMint, 'treasury balance = fee')
    assertBn(await token.balanceOf(nodeOperator1.address), nodeOperatorsFeeToMint, 'nodeOperator1 balance = fee')
    assertBn(nodeOperator1TokenDelta, nodeOperatorsFeeToMint, 'nodeOperator1 balance = fee')
  })

  it(`adds another node operator`, async () => {
    const txn = await nodeOperatorRegistry.addNodeOperator(nodeOperator2.name, nodeOperator2.address, { from: voting })
    await nodeOperatorRegistry.setNodeOperatorStakingLimit(1, 1, { from: voting })

    // Some Truffle versions fail to decode logs here, so we're decoding them explicitly using a helper
    nodeOperator2.id = getEventArgument(txn, 'NodeOperatorAdded', 'id', { decodeForAbi: NodeOperatorsRegistry._json.abi })
    assertBn(nodeOperator2.id, 1, 'operator id')

    assertBn(await nodeOperatorRegistry.getNodeOperatorsCount(), 2, 'total node operators')
    await nodeOperatorRegistry.addSigningKeysOperatorBH(
      nodeOperator2.id,
      1,
      nodeOperator2.validators[0].key,
      nodeOperator2.validators[0].sig,
      {
        from: nodeOperator2.address
      }
    )

    const totalKeys = await nodeOperatorRegistry.getTotalSigningKeyCount(nodeOperator2.id, { from: nobody })
    assertBn(totalKeys, 1, 'total signing keys')

    const unusedKeys = await nodeOperatorRegistry.getUnusedSigningKeyCount(nodeOperator2.id, { from: nobody })
    assertBn(unusedKeys, 1, 'unused signing keys')

    assertBn(await token.balanceOf(nodeOperator2.address), new BN(0), 'nodeOperator2 balance is zero')

    const ether2Stat = await pool.getBeaconStat()
    assertBn(ether2Stat.depositedValidators, 1, 'one validator have received the ether2')
    assertBn(ether2Stat.beaconBalance, ETH(33), 'remote ether2 not reported yet')
  })

  it(`deposits another amount to second operator's validator`, async () => {
    const depostitEthValue = 32
    const depositAmount = ETH(depostitEthValue)
    const awaitedShares = await pool.getSharesByPooledEth(depositAmount)
    const awaitedTokens = await pool.getPooledEthByShares(awaitedShares)

    const sharesBefore = await pool.getTotalShares()

    const receipt = await pool.submit(ZERO_ADDRESS, { value: depositAmount, from: user2 })

    // note: that number isn't equal to depositAmount
    assertEvent(receipt, 'Transfer', { expectedArgs: { from: 0, to: user2, value: awaitedTokens } })

    // 2 from the previous deposit of the first user
    assertBn(await pool.getBufferedEther(), ETH(depostitEthValue + 2), `all the ether is buffered until deposit`)

    // The amount of tokens corresponding to the deposited ETH value was minted to the user
    assertBn(await token.balanceOf(user2), awaitedTokens, 'user2 tokens')

    // current deposit + firstDeposit + first profit
    assertBn(await token.totalSupply(), ETH(depostitEthValue + 34 + 1), 'token total supply')
    // Total shares are equal to deposited eth before ratio change and fee mint
    assertBn(await token.getTotalShares(), sharesBefore.add(awaitedShares), 'total shares')
  })

  it(`the second deposit gets deployed`, async () => {
    const block = await waitBlocks(await depositSecurityModule.getMinDepositBlockDistance())
    const keysOpIndex = await nodeOperatorRegistry.getKeysOpIndex()
    const signatures = [
      signDepositData(
        await depositSecurityModule.ATTEST_MESSAGE_PREFIX(),
        depositRoot,
        keysOpIndex,
        block.number,
        block.hash,
        guardians.privateKeys[guardians.addresses[0]]
      ),
      signDepositData(
        await depositSecurityModule.ATTEST_MESSAGE_PREFIX(),
        depositRoot,
        keysOpIndex,
        block.number,
        block.hash,
        guardians.privateKeys[guardians.addresses[1]]
      )
    ]
    const [_, deltas] = await getSharesTokenDeltas(
      () => depositSecurityModule.depositBufferedEther(depositRoot, keysOpIndex, block.number, block.hash, signatures),
      treasuryAddr,
      nodeOperator1.address,
      nodeOperator2.address,
      user1,
      user2
    )

    assertBn(await nodeOperatorRegistry.getUnusedSigningKeyCount(0), 0, 'no more available keys')
    const zeroBn = new BN(0)
    // deposit doesn't change any kind of balances
    deltas.forEach((delta, i) => assertBn(delta, zeroBn, `delta ${i} is zero`))
  })

  it(`delta shares are zero on no profit reported after the deposit`, async () => {
    const [_, deltas] = await getSharesTokenDeltas(
      () => reportBeacon(2, ETH(32 + 1 + 32)),
      treasuryAddr,
      nodeOperator1.address,
      nodeOperator2.address,
      user1,
      user2
    )

    assertBn(await nodeOperatorRegistry.getUnusedSigningKeyCount(0), 0, 'no more available keys')
    const zeroBn = new BN(0)
    // deposit doesn't change any kind of _shares_ balances
    deltas.forEach((delta, i) => i % 2 && assertBn(delta, zeroBn, `delta ${i} is zero`))
  })

  it(`balances change correctly on second profit`, async () => {
    const profitAmountEth = 2
    const profitAmount = ETH(profitAmountEth)
    const bufferedAmount = ETH(2)
    // first deposit + first profit + second deposit
    // note no buffered eth values
    const reportingValue = ETH(32 + 1 + 32 + profitAmountEth)
    const prevTotalShares = await pool.getTotalShares()

    const [{ valuesBefore, valuesAfter }, deltas] = await getSharesTokenDeltas(
      () => reportBeacon(2, reportingValue),
      treasuryAddr,
      nodeOperator1.address,
      nodeOperator2.address,
      user1,
      user2
    )

    const [
      treasuryTokenDelta,
      treasurySharesDelta,
      nodeOperator1TokenDelta,
      nodeOperator1SharesDelta,
      nodeOperator2TokenDelta,
      nodeOperator2SharesDelta,
      user1TokenDelta,
      user1SharesDelta,
      user2TokenDelta,
      user2SharesDelta
    ] = deltas

    const { reportedMintAmount, tos, values } = await readLastPoolEventLog()

    const {
      sharesToMint,
      nodeOperatorsSharesToMint,
      treasurySharesToMint,
      nodeOperatorsFeeToMint,
      treasuryFeeToMint
    } = await getAwaitedFeesSharesTokensDeltas(profitAmount, prevTotalShares, 2)

    // events are ok
    assert.equal(tos[0], nodeOperator1.address, 'second transfer to node operator 1')
    assert.equal(tos[1], nodeOperator2.address, 'third transfer to node operator 2')
    assert.equal(tos[2], treasuryAddr, 'third transfer to treasury address')

    assertBn(values[0].add(values[1]), nodeOperatorsFeeToMint, 'operator transfer amount is correct')
    assertBn(values[2], treasuryFeeToMint, 'treasury transfer amount is correct')

    const totalFeeToMint = nodeOperatorsFeeToMint.add(treasuryFeeToMint)

    assertBn(totalFeeToMint, reportedMintAmount, 'reported the expected total fee')

    assertBn(nodeOperator2SharesDelta, await pool.sharesOf(nodeOperator2.address), 'node operator 2 got only fee on balance')

    assertBn(nodeOperator1SharesDelta.add(nodeOperator2SharesDelta), nodeOperatorsSharesToMint, 'nodeOperator1 shares are correct')
    assertBn(treasurySharesDelta, treasurySharesToMint, 'treasury shares are correct')

    assertBn(nodeOperator1SharesDelta, nodeOperator2SharesDelta, 'operators with equal amount of validators received equal shares')

    // newSharePrice = newTotalPooledEther / (prevTotalShares + shares2mint)
    // SharePriceDelta = newSharePrice - prevSharePrice
    const reportingValueBN = new BN(reportingValue)
    const totalSupply = reportingValueBN.add(new BN(bufferedAmount))

    const treasuryBalanceAfter = valuesAfter[0]
    const treasuryShareBefore = valuesBefore[1]
    const nodeOperator1BalanceAfter = valuesAfter[2]
    const nodeOperator1ShareBefore = valuesBefore[3]
    const nodeOperator2BalanceAfter = valuesAfter[4]
    const nodeOperator2ShareBefore = valuesBefore[5]
    const user1BalanceAfter = valuesAfter[6]
    const user1SharesBefore = valuesBefore[7]
    const user2BalanceAfter = valuesAfter[8]
    const user2SharesBefore = valuesBefore[9]
    const singleNodeOperatorFeeShare = nodeOperatorsSharesToMint.div(new BN(2))

    const awaitingTotalShares = prevTotalShares.add(sharesToMint)

    assertBn(
      nodeOperator1BalanceAfter,
      nodeOperator1ShareBefore.add(singleNodeOperatorFeeShare).mul(totalSupply).div(awaitingTotalShares),
      `first node operator token balance is correct`
    )
    assertBn(
      nodeOperator2BalanceAfter,
      nodeOperator2ShareBefore.add(singleNodeOperatorFeeShare).mul(totalSupply).div(awaitingTotalShares),
      `first node operator token balance is correct`
    )
    assertBn(
      treasuryBalanceAfter,
      treasuryShareBefore.add(treasurySharesToMint).mul(totalSupply).div(awaitingTotalShares),
      'treasury token balance changed correctly'
    )
    assertBn(user1SharesDelta, new BN(0), `user1 didn't get any shares from profit`)
    assertBn(user1BalanceAfter, user1SharesBefore.mul(totalSupply).div(awaitingTotalShares), `user1 token balance increased`)
    assertBn(user2SharesDelta, new BN(0), `user2 didn't get any shares from profit`)
    assertBn(user2BalanceAfter, user2SharesBefore.mul(totalSupply).div(awaitingTotalShares), `user2 token balance increased`)

    // TODO: the following two lines are from staking router, check them
    assertBn(await token.balanceOf(nodeOperatorsRegistry.address), nodeOperatorsFeeToMint, 'nodeOperatorsRegistry balance = fee')
    assertBn(nodeOperatorsRegistryTokenDelta, nodeOperatorsFeeToMint, 'nodeOperatorsRegistry balance = fee')
  })

  // test multiple staking modules erward distribution
  async function getAwaitedFeesSharesTokensDeltas(profitAmount, prevTotalShares, validatorsCount) {
    const totalPooledEther = await pool.getTotalPooledEther()
    const totalShares = await pool.getTotalShares()

    const totalFeeToDistribute = new BN(profitAmount).mul(new BN(totalFeePoints)).div(tenKBN)

    const sharesToMint = totalFeeToDistribute.mul(prevTotalShares).div(totalPooledEther.sub(totalFeeToDistribute))
    const nodeOperatorsSharesToMint = sharesToMint.mul(new BN(nodeOperatorsFeePoints)).div(tenKBN)
    const treasurySharesToMint = sharesToMint.sub(nodeOperatorsSharesToMint)

    const validatorsCountBN = new BN(validatorsCount)

    const nodeOperatorsFeeToMint = nodeOperatorsSharesToMint
      .mul(totalPooledEther)
      .div(totalShares)
      .div(validatorsCountBN)
      .mul(validatorsCountBN)
    const treasuryFeeToMint = treasurySharesToMint.mul(totalPooledEther).div(totalShares)

    return {
      totalPooledEther,
      totalShares,
      totalFeeToDistribute,
      sharesToMint,
      nodeOperatorsSharesToMint,
      treasurySharesToMint,
      nodeOperatorsFeeToMint,
      treasuryFeeToMint
    }
  }

  async function getSharesTokenDeltas(tx, ...addresses) {
    const valuesBefore = await Promise.all(addresses.flatMap((addr) => [token.balanceOf(addr), token.sharesOf(addr)]))
    const receipt = await tx()
    const valuesAfter = await Promise.all(addresses.flatMap((addr) => [token.balanceOf(addr), token.sharesOf(addr)]))
    return [{ receipt, valuesBefore, valuesAfter }, valuesAfter.map((val, i) => val.sub(valuesBefore[i]))]
  }

  async function readLastPoolEventLog() {
    const events = await pool.getPastEvents('Transfer')
    let reportedMintAmount = new BN(0)
    const tos = []
    const values = []
    events.forEach(({ args }) => {
      reportedMintAmount = reportedMintAmount.add(args.value)
      tos.push(args.to)
      values.push(args.value)
    })
    return {
      reportedMintAmount,
      tos,
      values
    }
  }
})
