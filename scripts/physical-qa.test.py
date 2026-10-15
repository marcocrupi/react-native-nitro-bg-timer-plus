#!/usr/bin/env python3
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('physical_validator',ROOT/'scripts/physical-qa-validate.py')
v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)

class PhysicalOracleTests(unittest.TestCase):
    def context(self,scenario='timers',platform='android'):
        return dict(runId='host-test',scenario=scenario,platform=platform,deviceId='physical-id',pid=1234,pidAfter=1234,
                    captureAlive=True,artifactBefore='sha',artifactAfter='sha',wakeLockAfter=False,serviceAfter=False)
    def rows(self):
        return [dict(event='START',hermes=True),dict(event='SCHEDULE',timeout=1,cancelled=2,interval=3,reentrant=4),
          dict(event='CLEAR',timerId=2,kind='timeout',delay=250),
          dict(event='CALLBACK',timerId=1),*[dict(event='CALLBACK',timerId=3,tick=i) for i in [1,2,3]],
          *[dict(event='CALLBACK',timerId=10+i,order=i) for i in range(8)],dict(event='CALLBACK',timerId=30,reentrant=True),
          dict(event='CHECK',name='timers',outcome='PASS',fired=1,cancelled=0,ticks=3,reentrant=1,order='0,1,2,3,4,5,6,7'),
          dict(event='CHECK',name='terminal-dispose',outcome='PASS',rejects=4,late=0),
          dict(event='CLEANUP',disposed=True,workers=[],notifications=[]),dict(event='RESULT',outcome='PASS')]
    def log(self,rows,context=None):
        c=context or self.context()
        result=[]
        for i,row in enumerate(rows,1):
            record=dict(runId=c['runId'],scenario=c['scenario'],platform=c['platform'],deviceId=c['deviceId'],pid=1234,
                        runtime='runtime1',seq=i,wall=10000+i,mono=i,state='active',**row)
            payload='[NitroBgPhysical] '+json.dumps(record)
            result.append(('10-15 12:00:00.000 1234 1234 I ReactNativeJS: ' if c['platform']=='android' else
              '2026-10-15 12:00:00.000 Df NitroBgTimerExample[1234:abcd] (Foundation) ')+payload+'\n')
        return ''.join(result)
    def reject(self,rows=None,context=None,text=None):
        with self.assertRaises(v.InvalidEvidence):
            v.validate(text if text is not None else self.log(rows if rows is not None else self.rows()),context or self.context())
    def test_positive_and_mirrors(self):
        text=self.log(self.rows())
        doubled=''.join(line+line for line in text.splitlines(True))
        self.assertTrue(v.validate(doubled,self.context()))
    def test_unexpected_second_runtime(self):
        text=self.log(self.rows());extra=text.splitlines(True)[0].replace('runtime1','unexpected-runtime')
        self.reject(text=extra+text)
    def test_marker_only_pass(self): self.reject([self.rows()[0],*self.rows()[-4:]])
    def test_missing_callback(self): self.reject([r for r in self.rows() if r.get('timerId')!=1])
    def test_duplicate_callback(self): self.reject(self.rows()[:-4]+[dict(event='CALLBACK',timerId=1)]+self.rows()[-4:])
    def test_cancelled_callback(self): self.reject(self.rows()[:-4]+[dict(event='CALLBACK',timerId=2)]+self.rows()[-4:])
    def test_wrong_run_id(self): self.reject(text=self.log(self.rows()).replace('host-test','stale-test'))
    def test_wrong_pid(self): self.reject(text=self.log(self.rows()).replace('1234','5678'))
    def test_wrong_device(self): self.reject(text=self.log(self.rows()).replace('physical-id','another-id'))
    def test_missing_sequence(self): self.reject(text=''.join(self.log(self.rows()).splitlines(True)[1:]))
    def test_invalid_clock(self): self.reject(text=self.log(self.rows()).replace('"mono": 1,','"mono": NaN,'))
    def test_clock_order(self): self.reject(text=self.log(self.rows()).replace('"mono": 3,','"mono": -1,'))
    def test_conflicting_identity(self):
        lines=self.log(self.rows()).splitlines(True)
        self.reject(text=lines[0]+lines[0].replace('"active"','"background"')+''.join(lines[1:]))
    def test_capture_ended(self):
        c=self.context();c['captureAlive']=False;self.reject(context=c)
    def test_artifact_changed(self):
        c=self.context();c['artifactAfter']='other';self.reject(context=c)
    def test_pid_changed(self):
        c=self.context();c['pidAfter']=5678;self.reject(context=c)
    def test_cleanup_incomplete(self):
        c=self.context();c['wakeLockAfter']=True;self.reject(context=c)
    def test_cleanup_worker_remaining(self):
        rows=self.rows();rows[-2]['workers']=[{'id':1}];self.reject(rows)
    def test_timeout_incomplete(self): self.reject(self.rows()[:-1])
    def test_missing_check(self): self.reject([r for r in self.rows() if r.get('name')!='timers'])
    def test_fail_after_pass(self): self.reject(self.rows()+[dict(event='FAILURE',reason='late')])
    def test_crash_after_pass(self):
        self.reject(text=self.log(self.rows())+'10-15 12:00:00.000 1234 1234 E AndroidRuntime: FATAL EXCEPTION: main\n')
    def background_fixture(self):
        c=self.context('background')
        rows=[dict(event='START'),dict(event='APP_STATE',observed='active'),dict(event='READY'),
              dict(event='APP_STATE',observed='background'),dict(event='CALLBACK',timerId=1,qualifying=True),
              dict(event='APP_STATE',observed='active'),dict(event='CHECK',name='background-delivery',outcome='PASS'),
              dict(event='CLEANUP',disposed=True,workers=[],notifications=[]),dict(event='RESULT',outcome='PASS')]
        text=self.log(rows,c)
        lines=text.splitlines(True);lines[4]=lines[4].replace('"state": "active"','"state": "background"')
        text=''.join(lines)
        c.update(homeExit=0,resumeExit=0,homeOffset=len(''.join(lines[:3]).encode()),resumeOffset=len(''.join(lines[:5]).encode()),liveCallbackSeen=True)
        return c,text
    def test_positive_background(self):
        c,text=self.background_fixture();self.assertTrue(v.validate(text,c))
    def test_home_failed(self):
        c,text=self.background_fixture();c['homeExit']=1;self.reject(context=c,text=text)
    def test_resume_failed(self):
        c,text=self.background_fixture();c['resumeExit']=1;self.reject(context=c,text=text)
    def test_callback_after_resume(self):
        c,text=self.background_fixture();c['resumeOffset']=c['homeOffset'];self.reject(context=c,text=text)
    def test_no_live_receipt(self):
        c,text=self.background_fixture();c['liveCallbackSeen']=False;self.reject(context=c,text=text)
    def test_ios_native_lifecycle_required(self):
        c,text=self.background_fixture();c['platform']='ios'
        text=text.replace('10-15 12:00:00.000 1234 1234 I ReactNativeJS: ', '2026-10-15 12:00:00.000 Df NitroBgTimerExample[1234:abcd] (Foundation) ').replace('"platform": "android"','"platform": "ios"')
        self.reject(context=c,text=text)

class BacklogOracleTests(unittest.TestCase):
    context=PhysicalOracleTests.context
    log=PhysicalOracleTests.log
    reject=PhysicalOracleTests.reject
    rows=PhysicalOracleTests.rows
    def backlog(self):
        c=self.context('backlog')
        rows=[dict(event='START'),dict(event='BACKLOG_ARMED',count=1500,drainCalls=0),
              dict(event='BLOCK_ENDED',duration=350.1,drainCalls=0)]
        events=[[i,0,i] for i in range(1,1501)]
        rows += [dict(event='NATIVE_BATCH',events=events[i:i+20]) for i in range(0,1500,20)]
        rows += [dict(event='DRAIN',count=1500,drainCalls=1)]
        rows += [dict(event='CALLBACK_BATCH',timerIds=list(range(i,min(i+40,1501)))) for i in range(1,1501,40)]
        rows += [dict(event='CHECK',name='backlog-1500',outcome='PASS'),dict(event='CLEANUP',disposed=True,workers=[],notifications=[]),dict(event='RESULT',outcome='PASS')]
        return c,rows
    def test_batch_backlog_positive(self):
        c,rows=self.backlog();self.assertTrue(v.validate(self.log(rows,c),c))
    def test_batch_missing_callback(self):
        c,rows=self.backlog();next(r for r in rows if r['event']=='CALLBACK_BATCH')['timerIds'].pop()
        self.reject(context=c,text=self.log(rows,c))
    def test_batch_duplicate_callback(self):
        c,rows=self.backlog();r=next(r for r in rows if r['event']=='CALLBACK_BATCH');r['timerIds'][1]=r['timerIds'][0]
        self.reject(context=c,text=self.log(rows,c))
    def test_batch_missing_native_expiry(self):
        c,rows=self.backlog();next(r for r in rows if r['event']=='NATIVE_BATCH')['events'].pop()
        self.reject(context=c,text=self.log(rows,c))
    def test_batch_bad_block(self):
        c,rows=self.backlog();next(r for r in rows if r['event']=='BLOCK_ENDED')['duration']=10000
        self.reject(context=c,text=self.log(rows,c))

class ProcessSupervisionTests(unittest.TestCase):
    def test_timeout_settles_child_ignoring_term(self):
        import time
        sp=importlib.util.spec_from_file_location('physical_runner',ROOT/'scripts/physical-qa.py')
        runner=importlib.util.module_from_spec(sp);sp.loader.exec_module(runner)
        with tempfile.TemporaryDirectory() as temp:
            out=Path(temp)
            child="import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(30)"
            leader="import subprocess,sys,time;from pathlib import Path;p=subprocess.Popen([sys.executable,'-c',"+repr(child)+"]);Path("+repr(str(out/'child.pid'))+").write_text(str(p.pid));time.sleep(30)"
            code,_=runner.command(out,'timeout',[os.sys.executable,'-c',leader],timeout=.3,check=False)
            self.assertEqual(code,124)
            pid=int((out/'child.pid').read_text())
            result=subprocess.run(['ps','-p',str(pid),'-o','stat='],capture_output=True,text=True)
            self.assertTrue(result.returncode!=0 or result.stdout.strip().startswith('Z'))

class RetryOracleTests(unittest.TestCase):
    context=PhysicalOracleTests.context
    log=PhysicalOracleTests.log
    reject=PhysicalOracleTests.reject
    rows=PhysicalOracleTests.rows
    def retry_fixture(self):
        c=self.context('retry')
        rows=[dict(event='START'),dict(event='APP_STATE',observed='active'),dict(event='READY'),
          dict(event='APP_STATE',observed='background'),dict(event='NATIVE_PROBE',phase='request'),
          dict(event='CHECK',name='retry-background-precondition',outcome='PASS'),dict(event='RETRY_ATTEMPT',phase='background'),
          dict(event='NATIVE_PROBE',phase='settle'),dict(event='RESUME_READY'),dict(event='APP_STATE',observed='active'),
          dict(event='SNAPSHOT',stage='retry-foreground',notifications=[{'title':'current'}]),
          dict(event='CHECK',name='retry-foreground',outcome='PASS'),dict(event='CLEANUP',disposed=True,workers=[],notifications=[]),dict(event='RESULT',outcome='PASS')]
        lines=self.log(rows,c).splitlines(True)
        for n in range(3,9):lines[n]=lines[n].replace('"state": "active"','"state": "background"')
        c.update(homeExit=0,resumeExit=0,homeOffset=len(''.join(lines[:3]).encode()),resumeOffset=len(''.join(lines[:9]).encode()))
        return c,lines
    def test_retry_control_positive(self):
        c,lines=self.retry_fixture();self.assertTrue(v.validate(''.join(lines),c))
    def test_retry_missing_native_probe(self):
        c,lines=self.retry_fixture();text=''.join(lines).replace('"event": "NATIVE_PROBE"','"event": "OTHER"');self.reject(context=c,text=text)
    def test_refusal_must_be_own_process_inside_request_window(self):
        c,lines=self.retry_fixture()
        errors=['10-15 12:00:00.000 1234 1234 W NitroBgTimer: Failed to start foreground service; retry on next explicit or timer request\n',
                '10-15 12:00:00.000 1234 1234 W NitroBgTimer: android.app.ForegroundServiceStartNotAllowedException: request denied\n']
        text=''.join(lines[:6]+errors+lines[6:]);c['resumeOffset']+=len(''.join(errors).encode())
        rows=v.validate(text,c)
        self.assertTrue(v.os_start_refusal(text,c,rows))
        self.assertFalse(v.os_start_refusal(text.replace('1234 1234 W','5678 5678 W'),c,rows))
        self.assertFalse(v.os_start_refusal(''.join(errors+lines),c,rows))

class SettlementAuthorityTests(unittest.TestCase):
    def test_unknown_group_never_publishes_settlement(self):
        from unittest.mock import patch
        sp=importlib.util.spec_from_file_location('physical_runner_unknown',ROOT/'scripts/physical-qa.py')
        runner=importlib.util.module_from_spec(sp);sp.loader.exec_module(runner)
        with tempfile.TemporaryDirectory() as temp:
            marker=Path(temp)/'settled'
            def unavailable(_): raise runner.PreflightError('controlled_ps_failure')
            with patch.dict(os.environ,{'QA_SETTLEMENT_FILE':str(marker)}), patch.object(runner,'query_group_members',unavailable):
                with self.assertRaises(runner.PreflightError): runner.group_members(99999)
                runner.record_settlement()
            self.assertFalse(marker.exists())
    def test_known_settlement_is_bound_to_parent(self):
        from unittest.mock import patch
        sp=importlib.util.spec_from_file_location('physical_runner_settled',ROOT/'scripts/physical-qa.py')
        runner=importlib.util.module_from_spec(sp);sp.loader.exec_module(runner)
        with tempfile.TemporaryDirectory() as temp:
            marker=Path(temp)/'settled'
            with patch.dict(os.environ,{'QA_SETTLEMENT_FILE':str(marker)}): runner.record_settlement()
            self.assertEqual(marker.read_text().strip(),str(os.getppid()))

class EntryPointTests(unittest.TestCase):
    def run_discovery(self,devices):
        with tempfile.TemporaryDirectory() as temp:
            d=Path(temp);adb=d/'adb'
            adb.write_text('#!/usr/bin/env python3\nimport sys\nprint('+repr('List of devices attached\n'+devices)+')\n')
            adb.chmod(0o755)
            return subprocess.run(['bash',str(ROOT/'scripts/physical-qa.sh'),'--dry-run','--platform','android','--artifacts',str(d/'out')],
              cwd=ROOT,env={**os.environ,'ADB':str(adb)},capture_output=True,text=True)
    def test_absent_device(self): self.assertEqual(self.run_discovery('').returncode,2)
    def test_ambiguous_device(self): self.assertEqual(self.run_discovery('one device\ntwo device\n').returncode,2)

if __name__=='__main__': unittest.main()
