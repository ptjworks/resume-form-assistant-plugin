// Worker 入口。逻辑都在 relay.mjs：入口模块只能导出处理程序，常量和工具函数不能从这里导出。
import { createWorker } from './relay.mjs';

export default createWorker();
