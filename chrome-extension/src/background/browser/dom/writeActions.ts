/**
 * What a click writes: the words a button carries when pressing it changes something on the site - a form is
 * sent, a thing is created, approved or deleted, money is paid, access is granted. A run that asks before such
 * a click lets the user stop a ticket from going out twice, or an approval from being given unasked.
 *
 * The list errs toward inclusion: a false positive costs one question, a false negative an irreversible click.
 */

/** Builds a case-insensitive matcher: English phrases match on word boundaries, Chinese phrases anywhere. */
function vocabulary(english: string[], chinese: string[]): RegExp {
  const words = english.map(word => word.trim().split(/\s+/).join('\\s*'));
  return new RegExp(`\\b(?:${words.join('|')})\\b|${chinese.join('|')}`, 'i');
}

const PAY_WORDS = vocabulary(
  [
    'pay',
    'payment',
    'pay now',
    'buy',
    'buy now',
    'purchase',
    'checkout',
    'check out',
    'place order',
    'order now',
    'complete order',
    'complete purchase',
    'book now',
    'subscribe',
    'donate',
    'transfer money',
    'top up',
  ],
  ['付款', '支付', '购买', '下单', '结账', '结算', '充值', '订阅', '转账', '捐款'],
);

const DELETE_WORDS = vocabulary(
  [
    'delete',
    'remove',
    'discard',
    'deactivate',
    'destroy',
    'erase',
    'purge',
    'trash',
    'unsubscribe',
    'cancel subscription',
    'cancel account',
    'cancel membership',
    'close account',
  ],
  ['删除', '移除', '清空', '注销', '取消订阅'],
);

const GRANT_WORDS = vocabulary(
  ['authorize', 'authorise', 'allow access', 'grant access', 'give access'],
  ['授权', '允许访问', '授予访问'],
);

/** A submission, a creation, an approval, a rejection: the button that sends or changes something */
const SUBMIT_WORDS = vocabulary(
  [
    'submit',
    'send',
    'publish',
    'post',
    'confirm',
    'apply',
    'sign up',
    'register',
    'save',
    'update',
    'create',
    'approve',
    'reject',
  ],
  ['提交', '发送', '发布', '确认', '保存', '更新', '创建', '批准', '拒绝', '驳回'],
);

/**
 * A cookie banner's refusal ("Reject all", "Reject cookies"), which turns something away rather than writing
 * it. A button of that name that submits a form is still a write.
 */
const COOKIE_REFUSAL = /cookie|^reject\s+all$|^(?:拒绝所有|全部拒绝|拒绝全部)$/i;

export type WriteKind = 'pay' | 'delete' | 'grant' | 'submit';

export interface WriteAction {
  kind: WriteKind;
  /** why this counts as a write, in words the user can check */
  reason: string;
}

/**
 * Whether clicking a control with this name writes something. The name is what the page calls the control:
 * its text, its aria-label, its title.
 */
export function writeAction(name: string): WriteAction | undefined {
  const label = name.trim();
  if (!label || COOKIE_REFUSAL.test(label)) return undefined;
  if (PAY_WORDS.test(label)) return { kind: 'pay', reason: `the name "${label}" is payment vocabulary` };
  if (GRANT_WORDS.test(label)) return { kind: 'grant', reason: `the name "${label}" grants access` };
  if (DELETE_WORDS.test(label)) return { kind: 'delete', reason: `the name "${label}" is destructive vocabulary` };
  if (SUBMIT_WORDS.test(label)) return { kind: 'submit', reason: `the name "${label}" is submission vocabulary` };
  return undefined;
}
