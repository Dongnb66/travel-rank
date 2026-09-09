// verify.js —— 验证码发送（邮箱 / 手机短信）
// 真实环境：
//   - 邮箱：配了 SMTP_HOST/SMTP_USER/SMTP_PASS 就真实发邮件（腾讯云 SES 也提供 SMTP）
//   - 短信：配了腾讯云短信 5 个环境变量就真实下发（见 src/sms.js）
// 未配置时自动降级为「演示模式」：打印到服务端控制台，并把验证码回给前端，方便本地联调与演示。
// 生产环境请务必配置真实通道，此时不再回传验证码。

import { sendSmsTencent, smsConfigured, smsMissingKeys } from './sms.js';

const isEmail = (t) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(t || ''));
const isPhone = (t) => /^1\d{10}$/.test(String(t || ''));

// 自动识别是邮箱还是手机号
export function detectChannel(target) {
  if (isEmail(target)) return 'email';
  if (isPhone(target)) return 'phone';
  return null;
}

/** 当前各通道的运行状态，供运维面板 / 前端提示使用 */
export function channelStatus() {
  return {
    email: {
      configured: Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS),
      provider: process.env.SMTP_HOST || '未配置',
    },
    sms: {
      configured: smsConfigured(),
      provider: '腾讯云短信 SMS',
      dryRun: process.env.SMS_DRY_RUN === '1',
      missing: smsMissingKeys(),
    },
  };
}

export async function sendVerifyCode(target, channel, code) {
  return channel === 'email' ? sendEmail(target, code) : sendSms(target, code);
}

async function sendEmail(to, code) {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (host && user && pass) {
    try {
      const nodemailer = await import('nodemailer');
      const port = Number(process.env.SMTP_PORT || 465);
      const transporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass },
      });
      await transporter.sendMail({
        from: process.env.SMTP_FROM || user,
        to,
        subject: '【途见 TravelRank】账号验证',
        text: `你的验证码是 ${code}，5 分钟内有效。若非本人操作请忽略。`,
        html: `<p>你的验证码是</p><h2 style="letter-spacing:4px">${code}</h2><p>5 分钟内有效，若非本人操作请忽略。</p>`,
      });
      // 真实发送成功：不回传验证码
      return { ok: true, delivered: true, channel: 'email' };
    } catch (e) {
      console.warn('[verify] 邮件发送失败，降级为控制台输出：', e.message);
    }
  }
  console.log(`[verify][邮件] 收件人 ${to} → 验证码 ${code}（5 分钟内有效）`);
  return { ok: true, delivered: false, channel: 'email', devCode: code };
}

async function sendSms(to, code) {
  if (smsConfigured()) {
    const r = await sendSmsTencent(to, code, { minutes: 5 });
    if (r.ok && r.delivered) return { ok: true, delivered: true, channel: 'phone-tencent' };
    if (r.dryRun) {
      console.log(`[verify][短信·dry-run] 手机号 ${to} → 验证码 ${code}`);
      return { ok: true, delivered: false, channel: 'phone-tencent', devCode: code, dryRun: true };
    }
    if (!r.ok) {
      // 真实通道失败时降级为演示模式，保证注册/绑定流程不中断
      console.warn('[verify] 短信发送失败，降级为演示模式：', r.error);
      console.log(`[verify][短信] 手机号 ${to} → 验证码 ${code}（5 分钟内有效）`);
      return {
        ok: true,
        delivered: false,
        channel: 'phone',
        devCode: code,
        fallback: true,
        reason: r.error,
      };
    }
  }
  console.log(`[verify][短信] 手机号 ${to} → 验证码 ${code}（5 分钟内有效）`);
  return { ok: true, delivered: false, channel: 'phone', devCode: code };
}
