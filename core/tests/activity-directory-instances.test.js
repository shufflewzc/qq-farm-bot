const test = require('node:test');
const assert = require('node:assert/strict');
const { buildActivityDirectory, registerYishuDirectoryWindow } = require('../dist/services/activity-center');
const { YISHU_START_MS, YISHU_END_MS, YISHU_UPDATED_AT_SEC } = require('../dist/config/yishuhuanfu-window');

test('milk tea and identically named share reward instances keep independent directory entries', () => {
    const windows = ['2026110100', '2026110101', '2026110102', '2026110103', '2026110104']
        .map(id => ({ id, name: '奶茶热销中', beginTime: 100, endTime: 200 }));
    windows.push({ id: '2026092501', name: '快乐不独享', beginTime: 100, endTime: 200 });
    const directory = buildActivityDirectory(windows, null, null, null, null);
    const milk = directory.find(entry => entry.gameplayKey === 'milk');
    assert.deepEqual(milk.activityIds, ['2026110100', '2026110101', '2026110102', '2026110103']);
    const share = directory.filter(entry => entry.gameplayKey === 'happy');
    assert.equal(share.length, 2);
    for (const id of ['2026110104', '2026092501']) {
        const instance = share.find(entry => entry.instanceId === id);
        assert.equal(instance.name, '快乐不独享');
        assert.deepEqual(instance.activityIds, [id]);
        assert.equal(instance.detailTarget, 'happy');
    }
});

test('the farm directory resolves the sweet potato group to one gameplay and retains its registered period', () => {
    const startTime = YISHU_START_MS / 1000;
    const endTime = YISHU_END_MS / 1000;
    const window = (id, begin, end) => ({ id, beginTime: begin, endTime: end });
    const unrelated = { ...window('2026110100', 100, 200), name: '奶茶热销中' };
    const getDirectory = input => buildActivityDirectory(registerYishuDirectoryWindow(input), null, null, null, null);

    const withLiveWindows = getDirectory([
        unrelated,
        window('2026111707', startTime, endTime),
        window('2026111708', startTime + 60, endTime - 60),
        window('2026111709', startTime, endTime),
    ]);
    assert.equal(withLiveWindows.length, 2);
    assert.equal(withLiveWindows[0].gameplayKey, 'milk');
    assert.equal(withLiveWindows[1].gameplayKey, 'yishuhuanfu');
    assert.equal(withLiveWindows[1].detailTarget, 'yishuhuanfu');
    assert.equal(withLiveWindows[1].name, '以薯换福');
    assert.equal(withLiveWindows[1].startTime, startTime + 60);
    assert.equal(withLiveWindows[1].endTime, endTime - 60);

    const [registered] = getDirectory([]);
    assert.equal(registered.startTime, startTime);
    assert.equal(registered.endTime, endTime);
    assert.equal(registered.updatedAt, YISHU_UPDATED_AT_SEC);
});
