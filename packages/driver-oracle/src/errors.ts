import { DriverError, type DriverErrorCode } from '@db-explorer/core';

/**
 * 原生错误 → DriverError 映射（驱动规范 §6，UI 只认 code 不解析 message；ADR D-23）。
 * node-oracledb 错误两族：ORA 数据库错误（message 前缀 'ORA-xxxxx'，thin 下 errorNum 可靠）
 * 与 NJS thin 客户端错误（前缀 'NJS-xxx'，无 errorNum）——统一按消息前缀解析错误号后查表。
 * message 为面向用户的一句话；原始信息放 detail（不含密码，C-10）。
 */

/** ORA 数据库错误号 → code + 用户文案 */
const ORA_MAP: Record<number, { code: DriverErrorCode; message?: string }> = {
  // 认证/账号
  1017: { code: 'E_AUTH', message: '认证失败：用户名或密码错误' },
  28000: { code: 'E_AUTH', message: '认证失败：账号已被锁定' },
  28001: { code: 'E_AUTH', message: '认证失败：密码已过期' },
  28002: { code: 'E_AUTH', message: '认证失败：密码已进入宽限期，请联系管理员修改' },
  // 取消（break()）
  1013: { code: 'E_CANCELED', message: '查询已取消' },
  // 约束
  1: { code: 'E_CONSTRAINT', message: '唯一约束冲突：数据重复' },
  2290: { code: 'E_CONSTRAINT', message: 'CHECK 约束冲突' },
  2291: { code: 'E_CONSTRAINT', message: '外键冲突：引用的数据不存在' },
  2292: { code: 'E_CONSTRAINT', message: '外键冲突：存在引用本记录的子数据' },
  1400: { code: 'E_CONSTRAINT', message: '非空约束冲突：必填列不能为 NULL' },
  1407: { code: 'E_CONSTRAINT', message: '非空约束冲突：该列不能更新为 NULL' },
  955: { code: 'E_CONSTRAINT', message: '对象名已被使用' },
  1920: { code: 'E_CONSTRAINT', message: '用户名与其他用户/角色冲突' },
  // 对象不存在
  942: { code: 'E_NOT_FOUND', message: '表或视图不存在' },
  1403: { code: 'E_NOT_FOUND', message: '未找到数据' },
  1918: { code: 'E_NOT_FOUND', message: '用户（schema）不存在' },
  // 语法
  904: { code: 'E_SYNTAX', message: '标识符（列名）无效，请检查拼写' },
  905: { code: 'E_SYNTAX', message: 'SQL 语法错误（缺少关键字）' },
  907: { code: 'E_SYNTAX', message: 'SQL 语法错误（缺少右括号）' },
  911: { code: 'E_SYNTAX', message: 'SQL 语法错误（含非法字符）' },
  913: { code: 'E_SYNTAX', message: 'SQL 语法错误（值数量不匹配）' },
  917: { code: 'E_SYNTAX', message: 'SQL 语法错误（缺少逗号）' },
  918: { code: 'E_SYNTAX', message: '列名有歧义，请用表名限定' },
  920: { code: 'E_SYNTAX', message: 'SQL 语法错误（关系操作符无效）' },
  922: { code: 'E_SYNTAX', message: 'SQL 语法错误（缺少或非法选项）' },
  933: { code: 'E_SYNTAX', message: 'SQL 命令未正确结束' },
  936: { code: 'E_SYNTAX', message: 'SQL 语法错误（缺少表达式）' },
  947: { code: 'E_SYNTAX', message: 'SQL 语法错误（值数量不足）' },
  957: { code: 'E_SYNTAX', message: '列名重复' },
  959: { code: 'E_SYNTAX', message: '表空间不存在' },
  972: { code: 'E_SYNTAX', message: '标识符过长（Oracle 上限 128 字符）' },
  979: { code: 'E_SYNTAX', message: '非 GROUP BY 表达式' },
  984: { code: 'E_SYNTAX', message: '该位置不允许使用列' },
  // 权限
  1031: { code: 'E_PERMISSION', message: '权限不足' },
  1045: { code: 'E_PERMISSION', message: '权限不足：用户缺少 CREATE SESSION 权限' },
  // 并发
  60: { code: 'E_CONFLICT', message: '事务死锁，已被服务端回滚：请重试' },
  8177: { code: 'E_CONFLICT', message: '序列化冲突，事务被回滚：请重试' },
  // 超时/锁等待
  30006: { code: 'E_TIMEOUT', message: '资源等待超时' },
  4021: { code: 'E_TIMEOUT', message: '锁等待超时：对象被其他会话占用' },
  // 连接/网络（TNS 族）
  12154: { code: 'E_CONN', message: '连接标识符无法解析（服务名/连接串有误）' },
  12170: { code: 'E_CONN', message: '网络通信失败' },
  12505: { code: 'E_CONN', message: '监听器不认识该 SID' },
  12514: { code: 'E_CONN', message: '监听器不认识该服务名（服务未注册或拼写有误）' },
  12516: { code: 'E_CONN', message: '监听器无可用处理进程' },
  12518: { code: 'E_CONN', message: '监听器分发客户端连接失败' },
  12528: { code: 'E_CONN', message: '实例未就绪（启动中或受阻）' },
  12541: { code: 'E_CONN', message: '无法连接到监听器（无监听程序或端口有误）' },
  12543: { code: 'E_CONN', message: '目标主机不可达' },
  12545: { code: 'E_CONN', message: '连接失败：目标主机不可达' },
  12560: { code: 'E_CONN', message: '协议适配器错误' },
  3113: { code: 'E_CONN', message: '通信通道结束（连接已中断）' },
  3114: { code: 'E_CONN', message: '未连接到数据库' },
  3135: { code: 'E_CONN', message: '连接失联' },
};

/** NJS（node-oracledb thin 客户端）错误号 → code + 用户文案 */
const NJS_MAP: Record<number, { code: DriverErrorCode; message?: string }> = {
  3: { code: 'E_VALIDATION', message: '连接串非法' },
  4: { code: 'E_VALIDATION', message: '参数值非法' },
  5: { code: 'E_VALIDATION', message: '参数值非法' },
  21: { code: 'E_VALIDATION', message: '连接串解析失败' },
  103: { code: 'E_AUTH', message: '认证失败：凭据无效' },
  // 超时（callTimeout 承载 timeoutMs，ADR D-23）
  123: { code: 'E_TIMEOUT', message: '操作超时（可在设置中调整）' },
  // 连接/网络
  500: { code: 'E_CONN', message: '数据库连接不可用' },
  501: { code: 'E_CONN', message: '驱动内部连接错误' },
  502: { code: 'E_CONN', message: '网络错误：无法连接到数据库' },
  503: { code: 'E_CONN', message: '数据库无响应' },
  521: { code: 'E_CONN', message: '连接超时：服务器不可达或拒绝连接' },
  522: { code: 'E_CONN', message: '连接被中断' },
  524: { code: 'E_CONN', message: '网络 I/O 错误' },
  525: { code: 'E_CONN', message: '收到非法数据包' },
  526: { code: 'E_CONN', message: '协议错误' },
  528: { code: 'E_CONN', message: '连接被数据库终止' },
};

/** 从错误消息解析 (ORA|NJS)-NNNNN 错误号（thin 两族都在 message 前缀可靠携带） */
export function parseOracleErrorCode(message: string): { family: 'ORA' | 'NJS'; num: number } | undefined {
  const m = /\b(ORA|NJS)-(\d{3,5})\b/.exec(message);
  if (!m) return undefined;
  return { family: m[1] as 'ORA' | 'NJS', num: Number(m[2]) };
}

/** 任意抛出值 → DriverError（已映射；非 ORA/NJS 的宿主网络错误按 E_CONN 兜底，其余 E_INTERNAL） */
export function toDriverError(err: unknown): DriverError {
  if (DriverError.is(err)) {
    return err;
  }
  const e = err as { errorNum?: number; message?: string };
  const raw = e.message ?? String(err);
  const headline = raw.split('\n')[0]?.trim() || raw;
  const detail = [e.errorNum !== undefined ? `errorNum=${e.errorNum}` : '', raw].filter(Boolean).join(' ');

  const parsed = parseOracleErrorCode(headline) ?? (e.errorNum !== undefined ? { family: 'ORA' as const, num: e.errorNum } : undefined);
  if (parsed) {
    const table = parsed.family === 'ORA' ? ORA_MAP : NJS_MAP;
    const mapped = table[parsed.num];
    if (mapped) {
      return new DriverError(mapped.code, mapped.message ?? headline, {
        detail,
        cause: err instanceof Error ? err : undefined,
      });
    }
    // 未收录的 ORA-04xxx/06xxx 系统类按类别粗兜底
    if (parsed.family === 'ORA' && (parsed.num >= 4000 && parsed.num < 7000)) {
      return new DriverError('E_INTERNAL', headline, { detail, cause: err instanceof Error ? err : undefined });
    }
    if (parsed.family === 'NJS' && parsed.num >= 500 && parsed.num < 600) {
      return new DriverError('E_CONN', headline, { detail, cause: err instanceof Error ? err : undefined });
    }
  }
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code && /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE/.test(code)) {
      return new DriverError('E_CONN', headline, { detail, cause: err });
    }
  }
  return new DriverError('E_INTERNAL', headline, { detail, cause: err instanceof Error ? err : undefined });
}
