const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const test = require('node:test');
const vm = require('node:vm');

const { getItemById, getPlantBySeedId } = require('../dist/config/gameConfig');
const { buildPlantingLayouts } = require('../dist/services/farm/land-analysis');
const { sortBagSeedsForPlanting } = require('../dist/services/farm/planting');
const { loadProto, types } = require('../dist/utils/proto');

test('activity sweet potato enters the bag priority order and fits a single plot', async () => {
    await loadProto();
    const body = types.BagReply.encode({
        item_bag: { items: [
            { id: 20306, count: 5 },
            { id: 20307, count: 3 },
            { id: 20307, count: 2 },
            { id: 40307, count: 48 },
        ] },
    }).finish();
    const file = require.resolve('../dist/services/warehouse');
    const localRequire = createRequire(file);
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
        exports: module.exports,
        module,
        require: name => name === '../utils/network'
            ? { sendMsgAsync: async () => ({ body }) }
            : localRequire(name),
    });

    const { getBagSeeds } = module.exports;
    const seeds = Array.from(await getBagSeeds());
    const prioritized = sortBagSeedsForPlanting(seeds, [20307, 20306]);
    assert.deepEqual(prioritized.map(seed => seed.seedId), [20307, 20306]);
    assert.equal(prioritized[0].count, 5);
    assert.equal(prioritized[0].plantSize, 1);
    assert.equal(getItemById(20307).type, 5);
    assert.equal(getPlantBySeedId(20307).fruit.id, 40307);
    assert.deepEqual(buildPlantingLayouts([1], prioritized[0].plantSize), [
        { anchorLandId: 1, landIds: [1] },
    ]);
});
