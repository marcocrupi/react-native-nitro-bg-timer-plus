#!/usr/bin/env python3
"""Strict Physical QA oracle, shared by live runner and adversarial host fixtures."""
import json
import math
import re
from pathlib import Path

SCENARIOS = ['timers', 'backlog', 'short-intervals', 'recreate', 'reload', 'fgs',
             'notification', 'optout', 'multi-owner', 'background', 'long-run', 'expiration', 'retry']
REQUIRED = {
 'timers': ['timers', 'terminal-dispose'], 'backlog': ['backlog-1500'],
 'short-intervals': ['interval-'+str(x) for x in ['0','0.1','0.5','0.999','1','1.5','2','10']]+['short-dispose'],
 'recreate': ['recreate'], 'reload': ['runtime-replaced','reload-timers'],
 'notification': ['QA-A','QA-B','QA-C','QA-D','QA-E'], 'optout': ['optout'],
 'multi-owner': ['distinct-owners','both-owners','owner-b-after-stop-a','owner-b-after-dispose-a'],
 'background': ['background-delivery'], 'fgs': ['background-delivery'],
 'long-run': ['background-delivery','five-minutes'], 'expiration': ['expiration-resume-timers'],
 'retry': ['retry-background-precondition','retry-foreground']}

class InvalidEvidence(ValueError):
    pass

def require(value, reason):
    if not value:
        raise InvalidEvidence(reason)

def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)

def records(text, run_id, platform, pid, scenario, device):
    output, seen = [], {}
    offset = 0
    for line in text.splitlines(True):
        start = offset
        offset += len(line.encode())
        if platform == 'android':
            match = re.match(r'^\d\d-\d\d\s+\S+\s+(\d+)\s+\d+\s+[VDIWEF]\s+[^:]+:\s?(.*)', line)
        else:
            match = re.search(r'\bNitroBgTimerExample\[(\d+):[^]]+\]\s+(.*)', line)
        if match and int(match[1]) == pid:
            require(not re.search(r'FATAL EXCEPTION|Fatal signal|SIGABRT|RCTFatal|Terminating app due to|Unhandled JS Exception|(?:Type|Reference|Range|Syntax)Error:', match[2]), 'runtime_crash')
            if platform == 'android':
                require(not re.search(r'\s[EF]\s+ReactNativeJS:', line), 'js_error_record')
            else:
                require(not (re.search(r'\s[EF]\s+NitroBgTimerExample\[',line) and '[com.facebook.react.log:javascript]' in match[2]), 'ios_js_error_record')
        if '[NitroBgPhysical] {' not in line:
            continue
        require(match is not None, 'marker_pid_unavailable')
        # Only a publication at the message boundary can qualify, never a quoted screen/log dump.
        payload = match[2].strip()
        if not payload.startswith('[NitroBgPhysical] '):
            payload = re.sub(r'^(?:\([^)]*\)|\[[^]]+\])\s+', '', payload)
        if not payload.startswith('[NitroBgPhysical] {'):
            continue
        try:
            row = json.loads(payload[len('[NitroBgPhysical] '):])
        except (ValueError, TypeError) as exc:
            raise InvalidEvidence('malformed_or_truncated_marker') from exc
        require(int(match[1]) == pid and row.get('pid') == pid, 'marker_process_mismatch')
        require(row.get('runId') == run_id, 'stale_run')
        require(row.get('scenario') == scenario and row.get('platform') == platform and row.get('deviceId') == device, 'marker_subject_mismatch')
        require(finite(row.get('wall')) and finite(row.get('mono')), 'invalid_clock')
        require(isinstance(row.get('runtime'), str) and bool(row['runtime']), 'runtime_missing')
        require(isinstance(row.get('seq'), int) and not isinstance(row.get('seq'),bool) and row['seq'] > 0, 'invalid_sequence')
        key = (row['runtime'], row['seq'])
        if key in seen:
            require(seen[key] == row, 'conflicting_event_identity')
            continue
        seen[key] = dict(row)
        previous = next((r for r in reversed(output) if r['runtime'] == row['runtime']), None)
        require(row['seq'] == (previous['seq'] + 1 if previous else 1), 'missing_or_unordered_event')
        require(not previous or (previous['mono'] <= row['mono'] and previous['wall'] <= row['wall']), 'clock_order')
        row['_offset'], row['_end'] = start, offset
        output.append(row)
    return output

def os_start_refusal(text, context, rows):
    probes=[r for r in rows if r['event']=='NATIVE_PROBE']
    if len(probes)!=2: return False
    lower,upper=probes[0]['_end'],probes[1]['_offset']
    offset=0
    caught=False;kind=False
    for line in text.splitlines(True):
        begin=offset;offset+=len(line.encode())
        match=re.match(r'^\d\d-\d\d\s+\S+\s+(\d+)\s+\d+\s+W\s+NitroBgTimer\s*:\s?(.*)',line)
        if match and int(match[1])==context['pid'] and lower<=begin<upper:
            caught |= 'Failed to start foreground service; retry on next explicit or timer request' in match[2]
            kind |= 'ForegroundServiceStartNotAllowedException:' in match[2]
    return caught and kind

def validate(text, context, final=True):
    run_id, platform, pid, scenario, device = (context[k] for k in ['runId','platform','pid','scenario','deviceId'])
    rows = records(text, run_id, platform, pid, scenario, device)
    if not rows:
        require(not final, 'no_markers')
        return None
    require(rows[0]['event'] == 'START', 'missing_start')
    require(not any(r['event'] in ['FAILURE','FORBIDDEN_CALLBACK'] or r.get('outcome') == 'FAIL' for r in rows), 'failure_event')
    results = [r for r in rows if r['event'] == 'RESULT']
    if not results:
        require(not final, 'incomplete_sequence')
        return rows
    require(len(results) == 1 and rows[-1] == results[0] and results[0].get('outcome') == 'PASS', 'invalid_result')
    require([r.get('name') for r in rows if r['event'] == 'CHECK'] == REQUIRED[scenario], 'missing_or_unordered_checks')
    cleanup = [r for r in rows if r['event'] == 'CLEANUP']
    require(len(cleanup) == 1 and cleanup[0].get('disposed') is True, 'cleanup_missing')
    require(cleanup[0]['seq'] == results[0]['seq'] - 1, 'cleanup_order')
    if platform == 'android':
        require(cleanup[0].get('workers') == [] and cleanup[0].get('notifications') == [], 'cleanup_resources_remaining')
    if scenario != 'reload':
        starts=[r for r in rows if r['event']=='START']
        require(len(starts)==1 and all(r['runtime']==starts[0]['runtime'] for r in rows), 'unexpected_runtime_or_start')
    if scenario == 'timers':
        schedule = [r for r in rows if r['event'] == 'SCHEDULE']
        require(len(schedule) == 1, 'timers_schedule_missing')
        scheduled = schedule[0]
        calls = [r for r in rows if r['event'] == 'CALLBACK']
        require(len(calls) == 13, 'timers_callback_count')
        require(sum(r.get('timerId') == scheduled['timeout'] for r in calls) == 1, 'timeout_callback_missing_or_duplicate')
        require(not any(r.get('timerId') == scheduled['cancelled'] for r in calls), 'cancelled_timer_fired')
        interval = [r for r in calls if r.get('timerId') == scheduled['interval']]
        require([r.get('tick') for r in interval] == [1,2,3], 'interval_ticks_invalid')
        require([r['order'] for r in calls if 'order' in r] == list(range(8)) and len({r['timerId'] for r in calls if 'order' in r})==8, 'callback_order_invalid')
        require(sum(r.get('reentrant') is True for r in calls) == 1, 'reentrant_callback_missing')
        clear = [r for r in rows if r['event']=='CLEAR' and r.get('timerId')==scheduled['cancelled']]
        require(len(clear)==1, 'timeout_clear_missing')
    if scenario == 'recreate':
        snaps = [r for r in rows if r['event']=='SNAPSHOT']
        require(len(snaps)==2, 'recreate_snapshots_missing')
        before, after = snaps
        require(before.get('activity') and after.get('activity') and before['activity']!=after['activity'] and
                before.get('context')==after.get('context') and before['runtime']==after['runtime'] and
                {w['id'] for w in before.get('workers',[])}=={w['id'] for w in after.get('workers',[])} and bool(after.get('workers')), 'recreation_identity_invalid')
        require(len([r for r in rows if r['event']=='CALLBACK'])>=3, 'recreated_timers_missing')
    if scenario == 'notification':
        snaps = [r for r in rows if r['event']=='SNAPSHOT']
        require([r.get('stage') for r in snaps]==['QA-A','QA-B','QA-C','QA-D','QA-E'], 'notification_sessions_missing')
        require(all(any(n.get('title')==r['stage'] and n.get('text')==r['stage']+'-text' for n in r.get('notifications',[])) for r in snaps), 'notification_content_stale')
    if scenario == 'multi-owner':
        events = [r for r in rows if r['event']=='NATIVE_EVENT']
        require({r.get('timerId') for r in events}=={101,202}, 'multi_owner_timer_events_missing')
        checks=[r for r in rows if r['event']=='CHECK']
        for previous, current in [(checks[1],checks[2]),(checks[2],checks[3])]:
            require(sum(r.get('timerId')==202 and previous['seq']<r['seq']<current['seq'] for r in events)>=2, 'surviving_owner_events_missing')
        snaps=[r for r in rows if r['event']=='SNAPSHOT']
        require(len(snaps)==2 and snaps[0].get('stage')=='both-owners' and snaps[1].get('stage')=='owner-b-only', 'owner_snapshots_missing')
        require(any(n.get('title')=='QA-Owner-B' for n in snaps[1].get('notifications',[])), 'owner_b_notification_missing')
    if scenario == 'optout':
        snaps=[r for r in rows if r['event']=='SNAPSHOT' and r.get('stage')=='optout-active']
        require(len(snaps)==1 and snaps[0].get('notifications')==[], 'optout_snapshot_missing')
        require(len([r for r in rows if r['event']=='CALLBACK'])>=3, 'optout_callbacks_missing')
        require(any(r['event']=='NATIVE_EVENT' and r.get('timerId')==9001 for r in rows), 'second_owner_optout_missing')
    if scenario == 'backlog':
        native = [r for r in rows if r['event'] == 'NATIVE_EVENT']
        calls = [r for r in rows if r['event'] == 'CALLBACK']
        for batch in [r for r in rows if r['event']=='NATIVE_BATCH']:
            require(isinstance(batch.get('events'),list) and 1<=len(batch['events'])<=20, 'invalid_native_batch')
            for event in batch['events']:
                require(isinstance(event,list) and len(event)==3, 'invalid_native_event')
                native.append(dict(timerId=event[0],timerType=event[1],nativeSequence=event[2],seq=batch['seq']))
        for batch in [r for r in rows if r['event']=='CALLBACK_BATCH']:
            require(isinstance(batch.get('timerIds'),list) and 1<=len(batch['timerIds'])<=40, 'invalid_callback_batch')
            calls.extend(dict(timerId=timer_id,seq=batch['seq']) for timer_id in batch['timerIds'])
        require(len(native) == len(calls) == 1500, 'backlog_count')
        require(all(isinstance(r.get('timerId'),int) and not isinstance(r.get('timerId'),bool) and isinstance(r.get('nativeSequence'),int) and not isinstance(r.get('nativeSequence'),bool) and r['nativeSequence']>0 for r in native), 'backlog_invalid_native_identity')
        require(all(isinstance(r.get('timerId'),int) and not isinstance(r.get('timerId'),bool) for r in calls), 'backlog_invalid_callback_identity')
        require({r.get('timerId') for r in native} == set(range(1,1501)), 'backlog_native_ids')
        require({r.get('timerId') for r in calls} == set(range(1,1501)), 'backlog_callback_ids')
        require(all(r.get('timerType') == 0 for r in native), 'backlog_wrong_type')
        require(all(a['nativeSequence'] < b['nativeSequence'] for a,b in zip(native,native[1:])), 'backlog_native_order')
        block = [r for r in rows if r['event'] == 'BLOCK_ENDED']
        drains = [r for r in rows if r['event'] == 'DRAIN']
        require(len(block) == len(drains) == 1 and block[0].get('drainCalls') == 0 and 350 <= block[0].get('duration',0) < 2000, 'backlog_block')
        require(drains[0].get('count') == 1500 and drains[0].get('drainCalls') == 1 and native[0]['seq'] > block[0]['seq'], 'backlog_drain')
    if scenario == 'short-intervals':
        clears = [r for r in rows if r['event'] == 'CLEAR']
        require([r.get('value') for r in clears] == [0,0.1,0.5,0.999,1,1.5,2,10], 'short_values_missing')
        for clear in clears:
            calls = [r for r in rows if r['event'] == 'CALLBACK' and r.get('timerId') == clear['timerId']]
            require(0 < len(calls) < 1000 and len(calls) == clear.get('ticks') and calls[-1]['seq'] < clear['seq'], 'short_clear_ineffective')
    if scenario == 'retry':
        probes=[r for r in rows if r['event']=='NATIVE_PROBE']
        require([r.get('phase') for r in probes]==['request','settle'], 'retry_native_control_missing')
        attempt=next((r for r in rows if r['event']=='RETRY_ATTEMPT'),None)
        require(attempt and probes[0]['state']=='background' and attempt['state']=='background' and probes[0]['seq']<attempt['seq']<probes[1]['seq'], 'retry_attempt_order')
        snap=next((r for r in rows if r['event']=='SNAPSHOT' and r.get('stage')=='retry-foreground'),None)
        require(snap and snap.get('state')=='active' and bool(snap.get('notifications')), 'retry_foreground_service_missing')
    if scenario == 'reload':
        starts = [r for r in rows if r['event'] == 'START']
        request_new=next((r for r in rows if r['event']=='RELOAD_NEW_TIMER_REQUEST'),None)
        require(context.get('reloadResourcesChecked') is True and context.get('reloadWakeLock') is False and context.get('reloadService') is False and
                request_new and request_new['_offset']>=context.get('reloadResourceEndOffset',-1), 'reload_resource_boundary_missing')
        require(len(starts) == 2 and starts[0]['runtime'] != starts[1]['runtime'], 'reload_runtime_not_replaced')
        require(any(r['event'] == 'RELOAD_REQUEST' and r['runtime'] == starts[0]['runtime'] for r in rows), 'reload_not_requested')
        snaps=[r for r in rows if r['event']=='SNAPSHOT']
        require(len(snaps)==2 and snaps[0].get('stage')=='old-runtime' and snaps[1].get('stage')=='new-runtime', 'reload_snapshots_missing')
        old,new=snaps
        request=next(r for r in rows if r['event']=='RELOAD_REQUEST')
        require(old.get('context') and new.get('context') and old['context']!=new['context'] and
                new.get('previousContext')==old['context'] and new.get('previousRuntime')==old['runtime'], 'reload_context_invalid')
        require(request.get('workers') and new.get('previousWorkers') and new.get('workers') and
                {w['id'] for w in request['workers']}=={w['id'] for w in new['previousWorkers']} and
                not ({w['id'] for w in new['workers']}&{w['id'] for w in new['previousWorkers']}), 'old_workers_not_terminated')
        require(len([r for r in rows if r['event']=='CALLBACK' and r['runtime']==new['runtime']])>=3, 'new_runtime_callbacks_missing')
        require(not any(r['runtime'] == starts[0]['runtime'] for r in rows[rows.index(starts[1])+1:]), 'old_runtime_still_active')
    if scenario in ['background','fgs','long-run','expiration','retry']:
        require(context.get('homeExit') == 0 and context.get('resumeExit') == 0, 'home_or_resume_failed')
        home, resume = context.get('homeOffset',-1), context.get('resumeOffset',-1)
        initial = next((r for r in rows if r['event']=='APP_STATE' and r.get('observed')=='active'), None)
        away = next((r for r in rows if r['event']=='APP_STATE' and r.get('observed')=='background' and r['_offset']>=home), None)
        active = next((r for r in rows if r['event']=='APP_STATE' and r.get('observed')=='active' and r['_offset']>=resume), None)
        require(initial and away and active and 0 <= home < resume and initial['_end'] <= home, 'background_timeline_missing')
        require(initial['mono'] <= away['mono'] <= active['mono'], 'background_clock_order')
        if scenario not in ['retry','expiration']:
            call = next((r for r in rows if r['event']=='CALLBACK' and r.get('qualifying') is True and r.get('state')=='background'), None)
            require(call and away['_end']<=call['_offset'] and call['_end']<=resume and call['mono']<=active['mono'], 'callback_not_live_before_resume')
            require(context.get('liveCallbackSeen') is True, 'background_live_receipt_missing')
        if platform == 'ios':
            offset=0
            qualified=False
            for line in text.splitlines(True):
                begin=offset;offset+=len(line.encode())
                match=re.search(r'\bNitroBgTimerExample\[(\d+):[^]]+\]\s+(?:\([^)]*\)\s+)?\[NitroBgPhysicalNative\] runId=([^ ]+) pid=(\d+) lifecycle=UIApplicationDidEnterBackgroundNotification wall=([\d.]+) mono=([\d.]+)',line)
                if match and int(match[1])==pid and int(match[3])==pid and match[2]==run_id and home<=begin<resume and finite(float(match[4])) and finite(float(match[5])):
                    qualified=True
            require(qualified, 'uikit_background_missing')
    if final:
        require(context.get('captureAlive') is True, 'capture_ended_early')
        require(context.get('artifactBefore') and context.get('artifactBefore') == context.get('artifactAfter'), 'artifact_changed')
        require(context.get('pidAfter') == pid, 'process_changed')
        if platform == 'android':
            require(context.get('wakeLockAfter') is False and context.get('serviceAfter') is False, 'external_cleanup_incomplete')
    return rows
