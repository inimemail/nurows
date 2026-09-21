export function parseStoredRecord(raw, kind = "state") {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(
      `持久化 ${kind} 数据损坏，已停止启动以保护原数据，请从备份恢复。`,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`持久化 ${kind} 数据格式错误，禁止回退为空数据。`);
  if (
    kind === "auth" &&
    (typeof value.configured !== "boolean" ||
      (value.configured &&
        (typeof value.username !== "string" ||
          !value.username ||
          !/^[a-f0-9]{32}$/i.test(value.salt || "") ||
          !/^[a-f0-9]{128}$/i.test(value.hash || ""))))
  ) {
    throw new Error("认证数据损坏，禁止重新初始化账户，请恢复备份。");
  }
  return value;
}
