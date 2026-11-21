# 平台接口层（`desktop/src/platform/`）

登录、云同步、社区广场、新手引导要等 Phase 2 才做。Phase 1 先把接口和接入点留好、入口全部隐藏，
Phase 2 只换实现、不改界面。

## 文件

| 文件 | 作用 |
| --- | --- |
| `types.ts` | DTO、`PlatformCapabilities` 开关、`PlatformUnavailableError` |
| `auth.ts` / `cloud-sync.ts` / `community.ts` / `onboarding.ts` | 四类服务的接口 |
| `local-only.ts` | Phase 1 本机实现：开关全 `false`，需要服务器的方法抛 `PlatformUnavailableError`（`code = "PLATFORM_UNAVAILABLE"`） |
| `registry.ts` | `getPlatformServices()` / `configurePlatformServices()`，默认装本机实现 |
| `visibility.ts` | `applyPlatformVisibility(root, capabilities)` |
| `launch-gate.ts` | `runLaunchGate(platform)`，启动动效与强制登录的唯一接入点 |
| `boot.ts` | `bootPlatform(root)`：取服务 → 应用显示开关 → 过启动闸门；`main.ts` 的 `boot()` 先调它 |

只能写可擦除的 TypeScript（不要 `enum`、构造函数参数属性、`namespace`），import 路径带 `.ts` 后缀，
因为 `npm run test:ui` 用 `node --experimental-strip-types` 直接跑这些文件。

## 能力开关

| 开关 | 控制 | `data-platform` 取值 |
| --- | --- | --- |
| `accountEnabled` | 头像按钮与账号抽屉（与是否强制登录无关） | `auth` |
| `cloudSyncEnabled` | 设置里的「账号与云同步」 | `cloud-sync` |
| `communityRemoteEnabled` | 在线社区广场 | `community-remote` |
| `spotlightOnboardingEnabled` | 新手引导（含「重看新手引导」入口） | `onboarding` |
| `requireAuthOnLaunch` | 启动时是否必须先登录；不对应页面元素，只由 `runLaunchGate` 读取 | — |

## 怎么加一个平台入口

1. 在 HTML 里给入口元素写 `data-platform="<取值>"`，**同时默认写上 `data-platform-off`**：

   ```html
   <button type="button" data-platform="auth" data-platform-off>账号</button>
   ```

   默认关闭是为了避免启动时闪一下。`tests/` 里有守卫：`index.html` 里只要有 `data-platform`
   而没有 `data-platform-off` 的元素，测试就会失败。
2. 不要用 `hidden` 属性做这个开关。设置面板靠 `hidden` 切分类，两者会冲突。
   隐藏靠 `styles.css` 里的 `[data-platform][data-platform-off] { display: none !important; }`。
3. 启动时 `applyPlatformVisibility` 按能力开关切 `data-platform-off`，页面代码不需要自己判断。
4. 开关为 `false` 时，这个入口背后的逻辑**不要挂载、不要调用任何平台接口**。
   在挂载处读 `getPlatformServices().capabilities.<开关>` 判断，不要先调接口再看结果。
5. 调用平台接口时从 `getPlatformServices()` 取，不要自己 new 实现，测试里才能用
   `configurePlatformServices` 换成假实现。
6. 取值写错（不在上表里）的元素会一直保持隐藏。

## Phase 2 怎么接

- 写真实实现（实现 `PlatformServices`），在 `boot()` 之前调用 `configurePlatformServices(real)`，
  并把对应的开关设为 `true`。界面代码不用改。
- 强制登录：在 `launch-gate.ts` 的 `runLaunchGate` 里，`requireAuthOnLaunch` 为 `true` 时接
  「启动动效 → 登录卡片 → 等登录成功」，返回后才进入投递页。
- 新手引导：登录成功进入主界面后调 `onboarding.shouldRunSpotlightTour()`。
- 需要服务器的方法在本机实现里抛 `PlatformUnavailableError`；调用方按 `error.code === PLATFORM_UNAVAILABLE`
  展示「平台服务暂未开放」之类的提示，不要当成未知故障。
