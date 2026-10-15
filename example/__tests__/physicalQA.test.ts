import { parsePhysicalQAUrl } from '../src/smoke/physicalQA'

jest.mock('react-native-nitro-bg-timer-plus', () => ({BackgroundTimer: {}, NitroBackgroundTimer: {}}), {virtual: true})

const url = 'nitrobgtimerexample://smoke?runId=qa-test&mode=qa&scenario=backlog&deviceId=usb-id'

test('QA requires explicit identity and scenario', () => {
  expect(parsePhysicalQAUrl(url)).toEqual({runId: 'qa-test', scenario: 'backlog', deviceId: 'usb-id'})
})
for (const [name, value] of [
  ['normal core', url.replace('&mode=qa', '')],
  ['UI mode', url.replace('mode=qa', 'mode=ui')],
  ['missing identity', url.replace('&deviceId=usb-id', '')],
  ['missing scenario', url.replace('&scenario=backlog', '')],
  ['invalid run ID', url.replace('qa-test', 'bad%20id')],
  ['malformed encoding', url.replace('qa-test', '%E0%A4%A')],
  ['duplicate fields', url+'&runId=second'],
  ['unknown scenario', url.replace('backlog','other')],
]) {
  test(`QA rejects ${name}`, () => expect(parsePhysicalQAUrl(value)).toBeNull())
}
