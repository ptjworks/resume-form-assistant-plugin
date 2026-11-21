export interface SpotlightStep {
  id: string;
  targetSelector: string;
  route: "applications" | "calendar" | "inbox" | "resume" | "community" | "settings";
  title: string;
  description: string;
}

export interface OnboardingService {
  /** 登录成功后进入主界面时调用 */
  shouldRunSpotlightTour(): Promise<boolean>;
  getSpotlightSteps(): SpotlightStep[];
  completeTour(): Promise<void>;
  /** 由「设置 -> 隐私与关于 -> 重看新手引导」调用 */
  replayTour(): Promise<void>;
}
