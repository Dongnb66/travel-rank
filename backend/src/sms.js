// sms.js —— 腾讯云短信（SMS）通道
// 采用腾讯云 API 3.0 的 TC3-HMAC-SHA256 签名，用 Node 内置 crypto 自行实现，
// 不依赖 tencentcloud-sdk-nodejs，保持本项目「零第三方依赖」的工程风格。
//
// 需要配置的环境变量（见 .env.example）：
//   TENCENTCLOUD_SECRET_ID        —— 腾讯云控制台 → 访问管理 → API 密钥
//   TENCENTCLOUD_SECRET_KEY
//   TENCENTCLOUD_SMS_SDK_APP_ID   —— 短信控制台 → 应用管理 → SDK AppID
//   TENCENTCLOUD_SMS_SIGN_NAME    —— 已审核通过的签名内容（如「途见旅行」）
//   TENCENTCLOUD_SMS_TEMPLATE_ID  —— 已审核通过的正文模板 ID
//   TENCENTCLOUD_SMS_REGION       —— 可选，默认 ap-guangzhou
//   SMS_DRY_RUN=1                 —— 只打印将要发送的请求体，不真正调用（联调用）
//
// 未配置时调用方会自动降级为「演示模式」，不会抛错。

import crypto from 'node:crypto';

const HOST = 'sms.tencentcloudapi.com';
const SERVICE = 'sms';
const VERSION = '2021-01-11';
const ACTION = 'SendSms';
const ALGORITHM = 'TC3-HMAC-SHA256';

const sha256hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const hmac = (key, msg) =>
  crypto
    .createHmac('sha256', typeof key === 'string' ? Buffer.from(key, 'utf8') : key)
    .update(msg, 'utf8')
    .digest();

export function smsConfigured() {
  return Boolean(
    process.env.TENCENTCLOUD_SECRET_ID &&
      process.env.TENCENTCLOUD_SECRET_KEY &&
      process.env.TENCENTCLOUD_SMS_SDK_APP_ID &&
      process.env.TENCENTCLOUD_SMS_SIGN_NAME &&
      process.env.TENCENTCLOUD_SMS_TEMPLATE_ID
  );
}

/** 缺失的配置项列表，便于前端 / 运维面板提示 */
export function smsMissingKeys() {
  const need = [
    'TENCENTCLOUD_SECRET_ID',
    'TENCENTCLOUD_SECRET_KEY',
    'TENCENTCLOUD_SMS_SDK_APP_ID',
    'TENCENTCLOUD_SMS_SIGN_NAME',
    'TENCENTCLOUD_SMS_TEMPLATE_ID',
  ];
  return need.filter((k) => !process.env[k]);
}

/**
 * TC3-HMAC-SHA256 签名
 * 文档：https://cloud.tencent.com/document/api/382/52071
 */
export function buildTc3Headers(
  payloadObj,
  timestampSec = Math.floor(Date.now() / 1000),
  opts = {}
) {
  const secretId = opts.secretId || process.env.TENCENTCLOUD_SECRET_ID;
  const secretKey = opts.secretKey || process.env.TENCENTCLOUD_SECRET_KEY;
  const region = opts.region || process.env.TENCENTCLOUD_SMS_REGION || 'ap-guangzhou';
  const service = opts.service || SERVICE;
  const host = opts.host || HOST;
  const action = opts.action || ACTION;

  const payload = JSON.stringify(payloadObj);
  const date = new Date(timestampSec * 1000).toISOString().slice(0, 10); // UTC 日期 YYYY-MM-DD

  // 1. 规范请求串
  const httpRequestMethod = 'POST';
  const canonicalUri = '/';
  const canonicalQueryString = '';
  const contentType = 'application/json; charset=utf-8';
  const canonicalHeaders =
    `content-type:${contentType}\n` + `host:${host}\n` + `x-tc-action:${action.toLowerCase()}\n`;
  const signedHeaders = 'content-type;host;x-tc-action';
  const canonicalRequest =
    httpRequestMethod +
    '\n' +
    canonicalUri +
    '\n' +
    canonicalQueryString +
    '\n' +
    canonicalHeaders +
    '\n' +
    signedHeaders +
    '\n' +
    sha256hex(payload);

  // 2. 待签字符串
  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign =
    ALGORITHM + '\n' + timestampSec + '\n' + credentialScope + '\n' + sha256hex(canonicalRequest);

  // 3. 计算签名（四层 HMAC）
  const secretDate = hmac('TC3' + secretKey, date);
  const secretService = hmac(secretDate, service);
  const secretSigning = hmac(secretService, 'tc3_request');
  const signature = crypto
    .createHmac('sha256', secretSigning)
    .update(stringToSign, 'utf8')
    .digest('hex');

  const authorization =
    `${ALGORITHM} Credential=${secretId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    'Content-Type': contentType,
    Host: host,
    'X-TC-Action': action,
    'X-TC-Version': opts.version || VERSION,
    'X-TC-Region': region,
    'X-TC-Timestamp': String(timestampSec),
    Authorization: authorization,
  };
}

const ERR_MAP = {
  LimitExceeded: '发送频率超限',
  InvalidPhoneNumber: '手机号格式错误',
  SignatureIncorrectOrUnapproved: '短信签名未审核通过',
  TemplateIncorrectOrUnapproved: '短信模板未审核通过',
  InsufficientBalance: '短信套餐包余额不足',
  AuthFailure: '密钥错误或无权限',
};

/**
 * 发送短信验证码
 * @param {string} phone 11 位大陆手机号
 * @param {string} code 验证码
 * @param {{minutes?:number}} opts
 * @returns {Promise<{ok:boolean, delivered?:boolean, dryRun?:boolean, error?:string, requestId?:string}>}
 */
export async function sendSmsTencent(phone, code, opts = {}) {
  if (!smsConfigured()) {
    return { ok: false, delivered: false, error: '腾讯云短信未配置', missing: smsMissingKeys() };
  }
  const minutes = opts.minutes || 5;
  const payload = {
    PhoneNumberSet: ['+86' + String(phone).trim()],
    SmsSdkAppId: process.env.TENCENTCLOUD_SMS_SDK_APP_ID,
    SignName: process.env.TENCENTCLOUD_SMS_SIGN_NAME,
    TemplateId: process.env.TENCENTCLOUD_SMS_TEMPLATE_ID,
    TemplateParamSet: [String(code), String(minutes)],
  };

  // 联调模式：只打印请求体，不真正扣费
  if (process.env.SMS_DRY_RUN === '1') {
    console.log('[sms][dry-run] 将发送：', JSON.stringify(payload, null, 2));
    return { ok: true, delivered: false, dryRun: true, channel: 'phone-tencent' };
  }

  const ts = Math.floor(Date.now() / 1000);
  const headers = buildTc3Headers(payload, ts);
  try {
    const res = await fetch('https://' + HOST + '/', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    const resp = data.Response || {};
    const st = Array.isArray(resp.SendStatusSet) ? resp.SendStatusSet[0] : null;
    if (st && st.Code === 'Ok') {
      return { ok: true, delivered: true, channel: 'phone-tencent', requestId: resp.RequestId };
    }
    const code2 = st?.Code || resp.Error?.Code || 'Unknown';
    const msg = ERR_MAP[code2] || st?.Message || resp.Error?.Message || '短信发送失败';
    console.warn('[sms] 腾讯云返回错误：', code2, msg);
    return { ok: false, delivered: false, error: `${msg}（${code2}）`, requestId: resp.RequestId };
  } catch (e) {
    console.warn('[sms] 腾讯云请求异常：', e.message);
    return { ok: false, delivered: false, error: '短信服务请求失败：' + e.message };
  }
}
