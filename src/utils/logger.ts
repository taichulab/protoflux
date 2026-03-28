// 检测是否处于调试模式（支持从环境变量 PROTOFLUX_DEBUG 或 DEBUG 中读取）
const _isDebug = process.env.PROTOFLUX_DEBUG === "1" || process.env.DEBUG === "1";

/**
 * 格式化日志输出，增加时间戳和标签。
 * 对对象进行安全处理，防止循环引用导致崩溃。
 */
function format(tag: string, args: any[]) {
  const ts = new Date().toISOString();
  const processedArgs = args.map(arg => {
    if (arg === null) return "null";
    if (arg === undefined) return "undefined";
    if (typeof arg === 'object') {
      try {
        // Ensure one-line output by NOT passing any indentation args to JSON.stringify
        return JSON.stringify(arg);
      } catch (e) {
        return `[Object: ${arg.constructor?.name || 'unknown'}]`;
      }
    }
    return String(arg);
  });
  
  return `[${ts}] [${tag}] ${processedArgs.join(" ")}`;
}

/**
 * 项目统一的轻量级日志对象。
 */
export const logger = {
  // 打印普通信息
  info: (...args: any[]) => console.log(format("INFO", args)),
  // 打印错误信息
  error: (...args: any[]) => console.error(format("ERROR", args)),
  // 仅在调试模式开启时打印详细信息
  debug: (...args: any[]) => {
    if (_isDebug) {
      console.log(format("DEBUG", args));
    }
  }
};
