const assert = require('assert');
const { LobbyCoordinator } = require('../src/utils/LobbyCoordinator');

async function runTests() {
    console.log('--- Testing LobbyCoordinator ---');

    const coordinator = new LobbyCoordinator(18, 100); // 18 lobbies, 100ms TTL for testing

    // Test 1: Sequentially assign lobbies 1 to 18
    console.log('1. Testing slot allocation for 18 lobbies...');
    for (let i = 1; i <= 18; i++) {
        const slot = coordinator.acquireLobby(`Bot_${i}`, `uuid_${i}`);
        assert.strictEqual(slot, i, `Bot_${i} should have been assigned lobby slot ${i}`);
    }

    // Test 2: Verify 19th bot cannot acquire a slot (all 18 occupied)
    console.log('2. Testing 19th bot rejection (capacity cap)...');
    const overflowSlot = coordinator.acquireLobby('Bot_19', 'uuid_19');
    assert.strictEqual(overflowSlot, null, '19th bot should receive null when 18 slots are occupied');

    // Test 3: Idempotent re-acquisition
    console.log('3. Testing idempotent slot retrieval...');
    const existingSlot = coordinator.acquireLobby('Bot_5', 'uuid_5');
    assert.strictEqual(existingSlot, 5, 'Bot_5 should retain lobby slot 5');

    // Test 4: Release a slot and re-assign
    console.log('4. Testing releasing and reclaiming slots...');
    const released = coordinator.releaseLobby('uuid_5');
    assert.strictEqual(released, 5, 'Should return released slot 5');

    const reassignedSlot = coordinator.acquireLobby('New_Bot', 'uuid_new');
    assert.strictEqual(reassignedSlot, 5, 'New bot should take the freed slot 5');

    // Test 5: Alert deduplication - join event
    console.log('5. Testing join event deduplication...');
    const joinAlert1 = coordinator.isDuplicateAlert('join', 'Technoblade', 'bedwarslobby1');
    assert.strictEqual(joinAlert1, false, 'First join alert should NOT be marked duplicate');

    const joinAlert2 = coordinator.isDuplicateAlert('join', 'Technoblade', 'bedwarslobby1');
    assert.strictEqual(joinAlert2, true, 'Second immediate join alert SHOULD be marked duplicate (suppressed)');

    const joinAlertOther = coordinator.isDuplicateAlert('join', 'Dream', 'bedwarslobby1');
    assert.strictEqual(joinAlertOther, false, 'Different player join alert should NOT be marked duplicate');

    // Test 6: Alert deduplication - chat event
    console.log('6. Testing chat event deduplication...');
    const chatAlert1 = coordinator.isDuplicateAlert('chat', 'Technoblade', 'bedwarslobby1', 'gg');
    assert.strictEqual(chatAlert1, false, 'First chat alert should NOT be duplicate');

    const chatAlert2 = coordinator.isDuplicateAlert('chat', 'Technoblade', 'bedwarslobby1', 'gg');
    assert.strictEqual(chatAlert2, true, 'Immediate duplicate chat alert SHOULD be duplicate (suppressed)');

    const chatAlert3 = coordinator.isDuplicateAlert('chat', 'Technoblade', 'bedwarslobby1', 'different text');
    assert.strictEqual(chatAlert3, false, 'Different chat text should NOT be duplicate');

    // Test 7: Deduplication expiration after TTL
    console.log('7. Testing deduplication TTL expiry...');
    await new Promise(r => setTimeout(r, 120)); // wait 120ms (> 100ms TTL)
    const joinAlertAfterTtl = coordinator.isDuplicateAlert('join', 'Technoblade', 'bedwarslobby1');
    assert.strictEqual(joinAlertAfterTtl, false, 'Join alert after TTL expiry should NOT be marked duplicate');

    // Test 8: Summary statistics
    console.log('8. Testing summary reporting...');
    const summary = coordinator.getSummary();
    assert.strictEqual(summary.totalLobbies, 18, 'Total lobbies should be 18');
    assert.strictEqual(summary.occupiedCount, 18, 'Occupied lobbies should be 18');
    assert.strictEqual(summary.freeCount, 0, 'Free lobbies should be 0');
    assert.strictEqual(summary.slots.length, 18, 'Slots array length should be 18');

    // Test 9: Clear coordinator
    console.log('9. Testing clear...');
    coordinator.clear();
    const clearedSummary = coordinator.getSummary();
    assert.strictEqual(clearedSummary.occupiedCount, 0, 'Occupied lobbies should be 0 after clear');
    assert.strictEqual(clearedSummary.freeCount, 18, 'Free lobbies should be 18 after clear');

    console.log('✅ ALL 9 TESTS PASSED SUCCESSFULLY!');
}

runTests().catch(err => {
    console.error('❌ Test failed:', err);
    process.exit(1);
});
