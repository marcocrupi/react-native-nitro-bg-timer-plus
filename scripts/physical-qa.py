#!/usr/bin/env python3
"""Physical example-only QA. Outputs and builds stay outside the repository."""
import argparse
import datetime
import tempfile
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import shlex
import signal
import plistlib
from urllib.parse import unquote, urlparse
import subprocess
import sys
import threading
import time
import uuid

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT/'scripts'
spec = importlib.util.spec_from_file_location('physical_validate', SCRIPT/'physical-qa-validate.py')
oracle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oracle)
PACKAGE = 'com.nitrobgtimerexample'
BUNDLE = 'org.reactjs.native.example.NitroBgTimerExample'
FROZEN = {
 'android/src/main/java/com/margelo/nitro/backgroundtimer/NitroBackgroundTimer.kt': '2713a48123faff2ad9a0bbfe162972ebc3297f65b468e4d156aca8fbbe29439f',
 'android/src/main/java/com/margelo/nitro/backgroundtimer/NitroBackgroundTimerPackage.kt': '9ba54c0122f51d33dabbaaebfdefc0eefb72d2d9aa66c1c3c76459dfc854c5f7',
 'android/src/main/java/com/margelo/nitro/backgroundtimer/NitroBackgroundTimerService.kt': '1465b5a218236e6dd3777e39d558a7fe1f85c778ff53a0e5a747594ccdd01cd2',
 'ios/NitroBackgroundTimer.swift': 'edce659f1f2ef00002d1f66f7b8b6d3dc0845e1d69e8161865d2c94d2ee1760a',
 'README.md': '5809e10f6369278d366941b938220058e7b035b12cc544d13d5cc2f1410c8277',
 'TESTING.md': 'a7908d42a57fab04e24c7e90c310efdf97d460ff6a87a958858f823797f3b3ad'}

SETTLEMENT_UNKNOWN = False
LOADED_RUNNER_SHA = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
LOADED_PARSER_SHA = hashlib.sha256((SCRIPT/'physical-qa-validate.py').read_bytes()).hexdigest()

class PreflightError(ValueError): pass
class ContractError(ValueError): pass

def sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def save(path, obj): Path(path).write_text(json.dumps(obj, indent=2, sort_keys=True)+'\n')
def now(): return datetime.datetime.now(datetime.timezone.utc).isoformat()
def inventory(app): return {str(p.relative_to(app)):sha(p) for p in sorted(app.rglob('*')) if p.is_file()}
def fingerprint(value): return hashlib.sha256(json.dumps(value,sort_keys=True).encode()).hexdigest()

def group_members(group):
    global SETTLEMENT_UNKNOWN
    try: return query_group_members(group)
    except BaseException:
        SETTLEMENT_UNKNOWN=True
        raise

def query_group_members(group):
    result=subprocess.run(['ps','-axo','pid=,pgid=,stat='],capture_output=True,text=True,timeout=2)
    if result.returncode: raise PreflightError('process_group_unverifiable')
    rows=[line.split() for line in result.stdout.splitlines() if line.strip()]
    if not rows or any(len(row)!=3 or not row[0].isdigit() or not row[1].isdigit() for row in rows):
        raise PreflightError('process_table_unverifiable')
    return [int(row[0]) for row in rows if int(row[1])==group and not row[2].startswith('Z')]

def settle_group(child):
    global SETTLEMENT_UNKNOWN
    # A reaped leader does not prove its descendants have settled.
    members=group_members(child.pid)
    if not members: return False
    try: os.killpg(child.pid,signal.SIGTERM)
    except ProcessLookupError: pass
    end=time.monotonic()+.7
    while time.monotonic()<end and group_members(child.pid): time.sleep(.05)
    if group_members(child.pid):
        try: os.killpg(child.pid,signal.SIGKILL)
        except ProcessLookupError: pass
    end=time.monotonic()+2
    while time.monotonic()<end and group_members(child.pid): time.sleep(.05)
    if group_members(child.pid):
        SETTLEMENT_UNKNOWN=True
        raise PreflightError('owned_group_unsettled')
    return True

def command(out, name, args, timeout=45, check=True, cwd=ROOT, env=None):
    out.mkdir(parents=True, exist_ok=True)
    start = now()
    with (out/(name+'.log')).open('w') as f:
        child=subprocess.Popen([str(a) for a in args],cwd=cwd,stdout=f,stderr=subprocess.STDOUT,
                               env=env,start_new_session=True)
        try:
            code=child.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            settle_group(child);child.wait(timeout=5);code=124
        except BaseException:
            settle_group(child);child.wait(timeout=5)
            raise
        finally:
            remaining=settle_group(child)
        if remaining and code==0: code=2
    text = (out/(name+'.log')).read_text(errors='replace')
    row = dict(name=name, argv=[str(a) for a in args], cwd=str(cwd), start=start, end=now(), rawExit=code)
    with (out/'commands.jsonl').open('a') as f: f.write(json.dumps(row)+'\n')
    (out/(name+'.exit')).write_text(str(code)+'\n')
    if check and code != 0: raise PreflightError(f'{name}: raw exit {code}; {out/(name+".log")}')
    return code, text

def source_inventory():
    names = subprocess.check_output(['git','ls-files','-z','--cached','--others','--exclude-standard'],cwd=ROOT).split(b'\0')
    return {p.decode():sha(ROOT/p.decode()) for p in names if p and not p.decode().startswith('scripts/') and not p.decode().endswith('.md')}

def protect():
    for path, digest in FROZEN.items():
        if sha(ROOT/path) != digest: raise PreflightError('frozen_candidate_changed:'+path)
    if subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip() != '741b0799b1be0c5f48466a2a3a2827b387e57a66':
        raise PreflightError('authorized_baseline_changed')
    if subprocess.check_output(['git','diff','--cached','--name-only'],cwd=ROOT): raise PreflightError('staging_not_empty')
    p=subprocess.run(['git','diff','--exit-code','HEAD','--','src','android','ios','nitrogen','package.json','yarn.lock',
       'example/package.json','example/ios/Podfile','example/ios/Podfile.lock','example/android/app/build.gradle'],cwd=ROOT,capture_output=True)
    if p.returncode: raise PreflightError('protected_source_changed')

def android_discover(out, device, allow_emulator=False):
    _, text = command(out,'android-discovery',[os.environ.get('ADB','adb'),'devices','-l'])
    authorized = [x.split()[0] for x in text.splitlines()[1:] if len(x.split())>1 and x.split()[1]=='device']
    if not device:
        if len(authorized) != 1: raise PreflightError('android_device_absent_or_ambiguous')
        device = authorized[0]
    if device not in authorized: raise PreflightError('android_device_not_authorized')
    adb=[os.environ.get('ADB','adb'),'-s',device]
    _, props=command(out,'android-properties',adb+['shell','getprop'])
    emulated='[ro.kernel.qemu]: [1]' in props or device.startswith('emulator-')
    if emulated and not allow_emulator: raise PreflightError('physical_device_required')
    if allow_emulator and not emulated: raise PreflightError('explicit_emulator_expected')
    command(out,'android-target-before',adb+['shell','dumpsys','package',PACKAGE])
    return device

def ios_discover(out, device, xcode):
    command(out,'ios-discovery',['xcrun','devicectl','list','devices','--json-output',out/'ios-devices.json'])
    devices=json.loads((out/'ios-devices.json').read_text())['result']['devices']
    physical=[d for d in devices if d.get('hardwareProperties',{}).get('reality')=='physical']
    if not device:
        if len(physical)!=1: raise PreflightError('ios_device_absent_or_ambiguous')
        device=physical[0]['identifier']
    command(out,'ios-details',['xcrun','devicectl','device','info','details','--device',device,'--json-output',out/'ios-details.json'])
    d=json.loads((out/'ios-details.json').read_text())['result']
    if d['hardwareProperties'].get('reality')!='physical' or d['connectionProperties'].get('pairingState')!='paired' or d['deviceProperties'].get('developerModeStatus')!='enabled':
        raise PreflightError('ios_pairing_developer_mode_or_reality')
    udid=d['hardwareProperties']['udid']
    if xcode and xcode!=udid: raise PreflightError('xcode_destination_not_same_device')
    command(out,'ios-destinations',['xcodebuild','-workspace','example/ios/NitroBgTimerExample.xcworkspace','-scheme','NitroBgTimerExample','-showdestinations'],timeout=90)
    return d['identifier'], udid

def build(out, platform, device, xcode, skip):
    receipt=out/(platform+'-build-receipt.json')
    sources=source_inventory()
    if skip:
        if not receipt.exists(): raise PreflightError('missing_build_receipt')
        old=json.loads(receipt.read_text())
        if old['sources']!=sources: raise PreflightError('stale_source_build')
        artifact=Path(old['artifact'])
        actual=sha(artifact) if platform=='android' else fingerprint(inventory(artifact))
        if actual!=old['sha256']: raise PreflightError('artifact_changed_since_build')
        return artifact, actual
    if platform=='android':
        command(out,'android-release-build',['./gradlew',':app:assembleRelease','-PreactNativeArchitectures=arm64-v8a','--no-daemon'],timeout=1200,cwd=ROOT/'example/android')
        artifact=out/'artifacts/example-release.apk'
        artifact.parent.mkdir(exist_ok=True)
        shutil.copy2(ROOT/'example/android/app/build/outputs/apk/release/app-release.apk',artifact)
        digest=sha(artifact)
    else:
        if (ROOT/'example/ios/Podfile.lock').read_bytes() != (ROOT/'example/ios/Pods/Manifest.lock').read_bytes():
            raise PreflightError('pods_sandbox_stale_run_bundle_exec_pod_install_deployment')
        dd=out/('ios-dd-'+uuid.uuid4().hex[:10])
        command(out,'ios-release-build',['xcodebuild','-workspace','example/ios/NitroBgTimerExample.xcworkspace','-scheme','NitroBgTimerExample',
            '-configuration','Release','-destination','platform=iOS,id='+xcode,'-derivedDataPath',dd,'build'],timeout=1800)
        artifact=dd/'Build/Products/Release-iphoneos/NitroBgTimerExample.app'
        command(out,'ios-codesign-verify',['codesign','--verify','--deep','--strict','--verbose=4',artifact])
        command(out,'ios-codesign-display',['codesign','-d','--verbose=4','--entitlements',':-',artifact])
        inv=inventory(artifact)
        save(out/'ios-bundle-inventory.json',inv)
        digest=fingerprint(inv)
    if sources!=source_inventory(): raise PreflightError('source_changed_during_build')
    save(receipt,dict(sources=sources,artifact=str(artifact),sha256=digest,finished=now()))
    return artifact,digest

def bash_helper(out, name, function, args):
    # Positional argv, never interpolate shell text or data into shell code.
    return command(out,name,['bash','-c','source "$1"; shift; "$@"','physical-qa',SCRIPT/'smoke-android.sh',function,*args])

def process_ios(out, device, label):
    command(out,label,['xcrun','devicectl','device','info','processes','--device',device,'--json-output',out/(label+'.json')])
    rows=json.loads((out/(label+'.json')).read_text())['result']['runningProcesses']
    own=[r for r in rows if r.get('executable','').endswith('/NitroBgTimerExample')]
    if len(own)!=1: raise ContractError('ios_target_process_missing_or_ambiguous')
    return int(own[0]['processIdentifier']),own[0]

def ios_install_chain(out, device, artifact, receipt_file, label, process=None):
    command(out,label,['xcrun','devicectl','device','info','apps','--device',device,'--bundle-id',BUNDLE,'--json-output',out/(label+'.json')])
    listing=json.loads((out/(label+'.json')).read_text())['result']
    receipt=json.loads(Path(receipt_file).read_text())
    if receipt.get('info',{}).get('outcome')!='success' or receipt['result'].get('deviceIdentifier')!=device:
        raise PreflightError('ios_install_receipt_device_mismatch')
    installed=[r for r in receipt['result']['installedApplications'] if r.get('bundleID')==BUNDLE]
    apps=[r for r in listing['apps'] if r.get('bundleIdentifier')==BUNDLE]
    if len(installed)!=1 or len(apps)!=1 or apps[0].get('url')!=installed[0].get('installationURL'):
        raise ContractError('ios_installed_container_changed')
    with (Path(artifact)/'Info.plist').open('rb') as f: info=plistlib.load(f)
    if apps[0].get('bundleVersion')!=info['CFBundleVersion'] or apps[0].get('version')!=info['CFBundleShortVersionString'] or not apps[0].get('builtByDeveloper'):
        raise ContractError('ios_installed_metadata_mismatch')
    container=unquote(urlparse(apps[0]['url']).path)
    if process is not None and unquote(urlparse(process.get('executable','')).path)!=container+info['CFBundleExecutable']:
        raise ContractError('ios_process_outside_installed_container')
    return container

def android_resources(out, adb, label):
    _, power=command(out,label+'-power',adb+['shell','dumpsys','power'])
    _, services=command(out,label+'-services',adb+['shell','dumpsys','activity','services',PACKAGE])
    _, notifications=command(out,label+'-notifications',adb+['shell','dumpsys','notification','--noredact','--package',PACKAGE])
    # Current Wake Locks section only. Historical ACQ/REL summaries are not resource state.
    match=re.search(r'^Wake Locks:.*?(?=^\S|\Z)',power,re.M|re.S)
    if not match: raise ContractError('wake_lock_snapshot_unavailable')
    _, uid_text=command(out,label+'-uid',adb+['shell','cmd','package','list','packages','-U',PACKAGE])
    uid_match=re.search(r'^package:'+re.escape(PACKAGE)+r' uid:(\d+)',uid_text,re.M)
    if not uid_match: raise ContractError('target_uid_unavailable')
    uid=uid_match[1]
    held=any('NitroBgTimer::WakeLock' in line and re.search(r'(?:uid=|ws=WorkSource\{)'+uid+r'\b',line) for line in match[0].splitlines())
    if any('NitroBgTimer::WakeLock' in line and not re.search(r'uid=\d+',line) for line in match[0].splitlines()):
        raise ContractError('wake_lock_owner_unavailable')
    service='ServiceRecord{' in services and 'NitroBackgroundTimerService' in services
    return held,service,services,notifications

def execute(platform,device,run_id,scenario,out,artifact,digest,source_receipt):
    out=Path(out);artifact=Path(artifact);out.mkdir(parents=True,exist_ok=True)
    context=dict(runId=run_id,platform=platform,deviceId=device,scenario=scenario,deviceReality='emulated' if device.startswith('emulator-') else 'physical',artifactBefore=digest,runnerSHA256=LOADED_RUNNER_SHA,parserSHA256=LOADED_PARSER_SHA)
    save(out/'context.json',context)
    adb=[os.environ.get('ADB','adb'),'-s',device]
    log=out/'device.log'
    child=None
    code=2
    stop_reader=None
    target_pid=None
    try:
        signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(TimeoutError('runner_cancelled')))
        protect()
        receipt=json.loads(Path(source_receipt).read_text())
        if receipt['sources']!=source_inventory() or receipt['sha256']!=digest:
            raise PreflightError('source_or_artifact_receipt_stale')
        url=f'nitrobgtimerexample://smoke?runId={run_id}&mode=qa&scenario={scenario}&deviceId={device}'
        if platform=='android':
            command(out,'force-stop',adb+['shell','am','force-stop',PACKAGE])
            bash_helper(out,'installed-before','harness_android_artifact',[adb[0],device,PACKAGE,str(artifact)])
            # Launch inert example first, bind capture to its known PID, then request QA.
            command(out,'launch-inert',adb+['shell','am','start','-W','-n',PACKAGE+'/.MainActivity'])
            _, text=command(out,'pid-before',adb+['shell','pidof',PACKAGE])
            target_pid=int(text.strip())
            args=adb+['logcat','-v','threadtime','--pid='+str(target_pid),'-T','1']
        else:
            command(out,'codesign-before',['codesign','--verify','--deep','--strict',artifact])
            args=['xcrun','devicectl','device','process','launch','--device',device,'--terminate-existing','--console',BUNDLE]
        child=subprocess.Popen(args,cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
        # Preserve host receipt times and exact byte boundaries independent of device clocks/buffering.
        def read_logs():
            with log.open('wb') as f,(out/'live-receipts.jsonl').open('w') as receipts:
                for line in iter(child.stdout.readline,b''):
                    f.write(line);f.flush()
                    receipts.write(json.dumps(dict(hostUTC=now(),hostMono=time.monotonic(),endOffset=f.tell(),line=line.decode(errors='replace')))+'\n');receipts.flush()
        reader=threading.Thread(target=read_logs,daemon=True);reader.start()
        time.sleep(2)
        if child.poll() is not None: raise ContractError('capture_ended_before_url')
        if platform=='ios':
            target_pid,process=process_ios(out,device,'process-before')
            context['installedContainerBefore']=ios_install_chain(out,device,artifact,Path(source_receipt).parent/'ios-install-receipt.json','installed-before',process)
            context['installedByteReadback']='NOT_AVAILABLE; signed local inventory + exact install receipt + current process/container chain'
        context['pid']=target_pid
        command(out,'open-url',adb+['shell','am','start','-W','-a','android.intent.action.VIEW','-d',shlex.quote(url),PACKAGE] if platform=='android' else
            ['xcrun','devicectl','device','process','launch','--device',device,'--payload-url',url,BUNDLE])
        deadline=time.monotonic()+(350 if scenario=='long-run' else 110 if scenario=='expiration' else 80 if scenario=='retry' else 65)
        home=False; resumed=False; sampled=False
        while time.monotonic()<deadline:
            if child.poll() is not None: raise ContractError('capture_ended_early')
            text=log.read_text(errors='replace') if log.exists() else ''
            rows=oracle.validate(text,context,final=False) or []
            if platform=='android' and scenario=='reload' and not context.get('reloadResourcesChecked') and any(r['event']=='RELOAD_CLEAN_READY' for r in rows):
                held,service,_,_=android_resources(out,adb,'reload-clean')
                context.update(reloadWakeLock=held,reloadService=service,reloadResourceEndOffset=log.stat().st_size,reloadResourcesChecked=True)
                oracle.require(not held and not service,'old_runtime_resources_remaining')
            if platform=='android' and not sampled and any(r['event']=='READY' or (r['event']=='SNAPSHOT' and r.get('stage') in ['optout-active','both-owners','QA-A']) for r in rows):
                held,service,s,n=android_resources(out,adb,'active')
                context.update(wakeLockActive=held,serviceActive=service)
                sampled=True
            if scenario in ['background','fgs','long-run','expiration','retry']:
                if not home and any(r['event']=='READY' and r['state']=='active' for r in rows):
                    context['homeOffset']=log.stat().st_size
                    context['homeHostMono']=time.monotonic()
                    code,_=command(out,'home',adb+['shell','input','keyevent','HOME'] if platform=='android' else
                        ['xcrun','devicectl','device','process','launch','--device',device,'--activate','com.apple.springboard'],check=False)
                    context['homeExit']=code; home=True
                    if code: raise ContractError('home_failed')
                trigger=any(r['event']=='CALLBACK' and r.get('qualifying') is True and r['state']=='background' for r in rows)
                if scenario=='retry': trigger=any(r['event']=='RESUME_READY' for r in rows)
                if scenario=='expiration':
                    trigger='Background task expiration handler fired' in text or (home and time.monotonic()-context.get('homeHostMono',time.monotonic())>=75)
                if home and not resumed and trigger:
                    if platform=='android' and scenario=='long-run':
                        held,service,services,_=android_resources(out,adb,'five-minute')
                        oracle.require(held and service and 'isForeground=true' in services,'long_run_service_not_current')
                        context['fiveMinuteServiceValidated']=True
                    context['liveCallbackSeen']=scenario!='retry'
                    context['resumeOffset']=log.stat().st_size
                    context['resumeHostMono']=time.monotonic()
                    code,_=command(out,'resume',adb+['shell','am','start','-W','-n',PACKAGE+'/.MainActivity'] if platform=='android' else
                       ['xcrun','devicectl','device','process','launch','--device',device,BUNDLE],check=False)
                    context['resumeExit']=code;resumed=True
                    if code: raise ContractError('resume_failed')
            if any(r['event']=='RESULT' for r in rows): break
            time.sleep(.2)
        else:
            raise TimeoutError('scenario_timeout')
        if platform=='android':
            bash_helper(out,'installed-after','harness_android_artifact',[adb[0],device,PACKAGE,str(artifact),str(target_pid),str(child.pid)])
            held,service,_,_=android_resources(out,adb,'after')
            context.update(wakeLockAfter=held,serviceAfter=service)
            _,text=command(out,'pid-after',adb+['shell','pidof',PACKAGE])
            context['pidAfter']=int(text.strip())
            context['artifactAfter']=sha(artifact)
        else:
            context['pidAfter'],process=process_ios(out,device,'process-after')
            save(out/'container.json',process)
            command(out,'codesign-after',['codesign','--verify','--deep','--strict',artifact])
            context['artifactAfter']=fingerprint(inventory(artifact))
            context['installedContainerAfter']=ios_install_chain(out,device,artifact,Path(source_receipt).parent/'ios-install-receipt.json','installed-after',process)
            oracle.require(context['installedContainerBefore']==context['installedContainerAfter'],'ios_container_changed')
        context['captureAlive']=child.poll() is None
        rows=oracle.validate(log.read_text(errors='replace'),context)
        if platform=='android' and scenario in ['fgs','long-run']:
            oracle.require(context.get('wakeLockActive') is True and context.get('serviceActive') is True,'active_service_or_wake_lock_missing')
            oracle.require('isForeground=true' in (out/'active-services.log').read_text() and ('0x40000000' in (out/'active-services.log').read_text() or '1073741824' in (out/'active-services.log').read_text()),'fgs_type_or_foreground_missing')
        if platform=='android' and scenario=='optout':
            oracle.require(context.get('wakeLockActive') is True and context.get('serviceActive') is False,'optout_not_wakelock_only')
        if scenario=='retry':
            refused=oracle.os_start_refusal(log.read_text(errors='replace'),context,rows)
            context['osRefusalObserved']=refused
            context['qualification']='PASS_RESET_RETRY' if refused else 'NOT_OBSERVED_OS_REFUSAL'
        if scenario=='expiration':
            observed='Background task expiration handler fired' in log.read_text(errors='replace')
            context['expirationObserved']=observed
            context['qualification']='HANDLER_OBSERVED_TASK_RELEASE_UNQUALIFIED' if observed else 'NOT_OBSERVED_EXPIRATION'
        save(out/'validated-events.json',rows)
        code=0
        if scenario=='retry' and not context.get('osRefusalObserved'):
            code=2;context['classification']='NOT_OBSERVED'
        if scenario=='expiration':
            # Release builds do not expose task identifier/end timestamps; full I05 stays unqualified.
            code=2;context['classification']='NOT_OBSERVED';context['taskIdentifierRelease']='NOT_OBSERVED'

    except TimeoutError as exc:
        context['error']=str(exc);code=124
    except (PreflightError,ContractError,oracle.InvalidEvidence,ValueError,OSError,KeyError) as exc:
        context['error']=str(exc);code=2 if isinstance(exc,PreflightError) else 1
    finally:
        # Resume only the authorized example on failure, then stop its own process.
        if context.get('homeExit')==0 and context.get('resumeExit') is None:
            command(out,'cleanup-resume',adb+['shell','am','start','-W','-n',PACKAGE+'/.MainActivity'] if platform=='android' else
                ['xcrun','devicectl','device','process','launch','--device',device,BUNDLE],check=False)
        if child is not None:
            context['captureExitBeforeCleanup']=child.poll()
            if code==0 and child.poll() is not None:
                code=1;context['error']='capture_ended_after_validation'
            # devicectl SIGTERM can be forwarded to the device app. Kill only the owned host capture.
            child.kill();child.wait(timeout=10)
            reader.join(timeout=5)
            context['captureCleanupExit']=child.returncode
            if code==0:
                try: oracle.validate(log.read_text(errors='replace'),context)
                except oracle.InvalidEvidence as exc: code=1;context['error']=str(exc)
        if platform=='android': command(out,'cleanup-stop',adb+['shell','am','force-stop',PACKAGE],check=False)
        elif target_pid:
            status,_=command(out,'cleanup-authority',['xcrun','devicectl','device','info','processes','--device',device,'--json-output',out/'cleanup-authority.json'],check=False)
            if status==0:
                current=json.loads((out/'cleanup-authority.json').read_text())['result']['runningProcesses']
                found=[p for p in current if p.get('processIdentifier')==target_pid]
                expected=context.get('installedContainerAfter',context.get('installedContainerBefore'))
                if found and expected and unquote(urlparse(found[0].get('executable','')).path)==expected+'NitroBgTimerExample':
                    stop_status,_=command(out,'cleanup-stop',['xcrun','devicectl','device','process','terminate','--device',device,'--pid',str(target_pid),'--kill'],check=False)
                    if stop_status: code=2;context['cleanupError']='authorized_process_stop_failed'
                elif found:
                    code=2;context['cleanupError']='PID_subject_changed_termination_refused'
                elif code==0:
                    code=1;context['cleanupError']='process_disappeared_before_cleanup'
            else:
                code=2;context['cleanupError']='process_authority_unverifiable_termination_refused'
        context['rawExit']=code
        save(out/'context.json',context)
        (out/'result.exit').write_text(str(code)+'\n')
        print(json.dumps(context),flush=True)
    return code

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--android-device');p.add_argument('--ios-device');p.add_argument('--xcodebuild-device-id')
    p.add_argument('--platform',choices=['android','ios','both'],default='both')
    p.add_argument('--scenario',choices=['core','battery-saver']+oracle.SCENARIOS,action='append')
    p.add_argument('--all',action='store_true');p.add_argument('--dry-run',action='store_true')
    p.add_argument('--allow-emulator',action='store_true',help='Explicitly select a disposable Android emulator; results stay emulated')
    p.add_argument('--skip-build',action='store_true');p.add_argument('--artifacts',required=True,type=Path)
    args=p.parse_args();out=args.artifacts.resolve()
    if ROOT==out or ROOT in out.parents: p.error('--artifacts must be outside the repository')
    if not args.all and not args.scenario and not args.dry_run: p.error('select --all or --scenario')
    protect();out.mkdir(parents=True,exist_ok=True)
    scenarios=(['core']+oracle.SCENARIOS+['battery-saver']) if args.all else (args.scenario or [])
    summary=[]
    for platform in ['android','ios'] if args.platform=='both' else [args.platform]:
        try:
            if platform=='android': device=android_discover(out,args.android_device,args.allow_emulator);xcode=None
            else: device,xcode=ios_discover(out,args.ios_device,args.xcodebuild_device_id)
            if args.dry_run:
                summary.append(dict(platform=platform,device=device,status='PREFLIGHT_ONLY',scenarios=scenarios));continue
            artifact,digest=build(out,platform,device,xcode,args.skip_build)
            command(out,platform+'-install',['bash',SCRIPT/'physical-qa.sh','--locked-command',platform,device]+([os.environ.get('ADB','adb'),'-s',device,'install','-r',artifact] if platform=='android' else
                ['xcrun','devicectl','device','install','app','--device',device,artifact,'--json-output',out/'ios-install-receipt.json']),timeout=120)
            for scenario in scenarios:
                if platform=='android' and scenario=='expiration':
                    summary.append(dict(platform=platform,scenario=scenario,status='NOT_APPLICABLE'));continue
                if platform=='ios' and scenario in ['recreate','reload','fgs','notification','optout','multi-owner','retry','long-run','battery-saver']:
                    summary.append(dict(platform=platform,scenario=scenario,status='NOT_APPLICABLE'));continue
                if scenario=='battery-saver':
                    summary.append(dict(platform=platform,scenario=scenario,status='NOT_RUN',reason='No safe non-global automation for enabling and restoring Battery Saver'));continue
                run_id='pqa-'+scenario+'-'+uuid.uuid4().hex[:16]
                lane=out/platform/run_id
                lane.mkdir(parents=True)
                if scenario=='core':
                    cmd=['bash',SCRIPT/'smoke-android.sh','--device',device,'--apk',artifact,'--run-id',run_id] if platform=='android' else [
                        'bash',SCRIPT/'smoke-ios.sh','--device',device,'--xcodebuild-device-id',xcode,'--configuration','Release','--skip-build','--derived-data',artifact.parents[3],'--run-id',run_id]
                    code,text=command(lane,'core',cmd,timeout=150,check=False)
                    # Preserve externally generated runner logs in this dossier as well.
                    for source in re.findall(r'(?:Log: |log=|-> )(/\S+\.log)',text):
                        if Path(source).is_file(): shutil.copy2(source,lane/Path(source).name)
                else:
                    if platform=='ios':
                        command(out,'ios-install',['bash',SCRIPT/'physical-qa.sh','--locked-command',platform,device,
                           'xcrun','devicectl','device','install','app','--device',device,artifact,'--json-output',out/'ios-install-receipt.json'],timeout=120)
                    code,_=command(lane,'runner',['bash',SCRIPT/'physical-qa.sh','--locked',platform,device,run_id,scenario,lane,artifact,digest,out/(platform+'-build-receipt.json')],timeout=430,check=False)
                row=dict(platform=platform,deviceReality='emulated' if device.startswith('emulator-') else 'physical',scenario=scenario,runId=run_id,rawExit=code,status='PASS' if code==0 else 'BLOCKED' if code==2 else 'FAIL',evidence=str(lane))
                if (lane/'context.json').exists():
                    details=json.loads((lane/'context.json').read_text())
                    if details.get('classification'): row['status']=details['classification']
                summary.append(row);save(out/'summary.json',summary)
                print(json.dumps(row),flush=True)
                # A real crash requires stopping the affected lane; tooling failures preserve evidence.
                if (lane/'context.json').exists() and 'runtime_crash' in (lane/'context.json').read_text(): break
        except (PreflightError,OSError,ValueError,KeyError) as exc:
            summary.append(dict(platform=platform,status='BLOCKED',reason=str(exc)));print(str(exc),file=sys.stderr,flush=True)
        save(out/'summary.json',summary)
    protect()
    save(out/'summary.json',summary)
    save(out/'evidence-sha256.json',{str(f.relative_to(out)):sha(f) for f in out.rglob('*') if f.is_file() and f.name!='evidence-sha256.json' and 'gems' not in f.parts and not any(x.startswith('ios-dd-') for x in f.parts)})
    return 2 if any(r['status'] in ['BLOCKED','NOT_OBSERVED'] for r in summary) else 1 if any(r['status']=='FAIL' for r in summary) else 0

def record_settlement():
    marker=os.environ.get('QA_SETTLEMENT_FILE')
    if marker and not SETTLEMENT_UNKNOWN:
        Path(marker).write_text(str(os.getppid())+'\n')

if __name__=='__main__':
    if len(sys.argv)>1 and sys.argv[1]=='--supervise':
        signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(TimeoutError('command_cancelled')))
        directory=Path(tempfile.mkdtemp(prefix='physical-qa-supervise-'))
        try:
            code,text=command(directory,'command',sys.argv[2:],timeout=150,check=False)
            print(text,end='');print('Supervision evidence: '+str(directory));record_settlement();sys.exit(code)
        except TimeoutError:
            record_settlement();sys.exit(124)
    if len(sys.argv)>1 and sys.argv[1]=='--execute':
        code=execute(*sys.argv[2:]);record_settlement();sys.exit(code)
    try: sys.exit(main())
    except (PreflightError,OSError,ValueError) as exc:
        print('PREFLIGHT: '+str(exc),file=sys.stderr);sys.exit(2)
