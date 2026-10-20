import { describe, it, expect } from 'vitest';
import { writeAction } from '../dom/writeActions';

describe('writeAction', () => {
  it('calls a button that sends or creates something a write', () => {
    expect(writeAction('Submit')?.kind).toBe('submit');
    expect(writeAction('Create')?.kind).toBe('submit');
    expect(writeAction('Approve')?.kind).toBe('submit');
    expect(writeAction('Reject')?.kind).toBe('submit');
    expect(writeAction('Publish changes')?.kind).toBe('submit');
    expect(writeAction('创建')?.kind).toBe('submit');
    expect(writeAction('批准')?.kind).toBe('submit');
    expect(writeAction('驳回')?.kind).toBe('submit');
  });

  it('calls a button that pays, deletes or grants access a write of its own kind', () => {
    expect(writeAction('Pay now')?.kind).toBe('pay');
    expect(writeAction('下单')?.kind).toBe('pay');
    expect(writeAction('Delete account')?.kind).toBe('delete');
    expect(writeAction('删除')?.kind).toBe('delete');
    expect(writeAction('Grant access')?.kind).toBe('grant');
    expect(writeAction('授权')?.kind).toBe('grant');
  });

  it('leaves a button that only reads or navigates alone', () => {
    expect(writeAction('Search')).toBeUndefined();
    expect(writeAction('Next')).toBeUndefined();
    expect(writeAction('Cancel')).toBeUndefined();
    expect(writeAction('关闭')).toBeUndefined();
    expect(writeAction('')).toBeUndefined();
  });

  it('does not take a cookie banner turning things away for a write', () => {
    expect(writeAction('Reject all')).toBeUndefined();
    expect(writeAction('Reject cookies')).toBeUndefined();
    expect(writeAction('拒绝所有')).toBeUndefined();
  });

  it('matches a word inside a longer name', () => {
    expect(writeAction('Submit application')?.kind).toBe('submit');
    expect(writeAction('Create a new issue')?.kind).toBe('submit');
  });

  it('does not match a word that only looks like one', () => {
    expect(writeAction('Posted by the author')).toBeUndefined();
    expect(writeAction('Recycle bin')).toBeUndefined();
    expect(writeAction('查看订单')).toBeUndefined();
  });
});
