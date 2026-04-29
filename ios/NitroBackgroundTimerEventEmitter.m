#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

static NSString *const NitroBackgroundTimerTimersAvailableEventName =
    @"NitroBackgroundTimerTimersAvailable";
static NSString *const NitroBackgroundTimerTimersAvailableNotificationName =
    @"NitroBackgroundTimerTimersAvailableNotification";

@interface NitroBackgroundTimerEventEmitter : RCTEventEmitter <RCTBridgeModule>
@end

@implementation NitroBackgroundTimerEventEmitter {
  BOOL _hasListeners;
}

RCT_EXPORT_MODULE(NitroBackgroundTimerEventEmitter)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (NSArray<NSString *> *)supportedEvents
{
  return @[ NitroBackgroundTimerTimersAvailableEventName ];
}

- (void)startObserving
{
  _hasListeners = YES;
  [[NSNotificationCenter defaultCenter] addObserver:self
                                           selector:@selector(handleTimersAvailable:)
                                               name:NitroBackgroundTimerTimersAvailableNotificationName
                                             object:nil];
}

- (void)stopObserving
{
  _hasListeners = NO;
  [[NSNotificationCenter defaultCenter] removeObserver:self
                                                  name:NitroBackgroundTimerTimersAvailableNotificationName
                                                object:nil];
}

- (void)handleTimersAvailable:(NSNotification *)notification
{
  if (!_hasListeners) {
    return;
  }

  [self sendEventWithName:NitroBackgroundTimerTimersAvailableEventName
                     body:notification.userInfo ?: @{}];
}

- (void)invalidate
{
  [[NSNotificationCenter defaultCenter] removeObserver:self];
  [super invalidate];
}

@end
