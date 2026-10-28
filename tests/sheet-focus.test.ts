import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {trapSheetTab} from '../src/ui/sheet-focus.ts';

test('phone sheet wraps at the selected roving tab and skips closed/hidden/disabled stops', () => {
  const dom = new JSDOM('<button id="outside">Open</button><aside><button id="details" tabindex="-1">Details</button><button id="team" tabindex="-1">Team</button><button id="lounge" tabindex="0">Lounge</button><button disabled>Unavailable</button><div hidden><button>Hidden</button></div><details><summary>Credits</summary><a href="#" id="closed">Collapsed link</a></details><a href="#" id="last">Story</a></aside>');
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {value:dom.window.document,configurable:true});
  try {
    const panel = document.querySelector('aside')!;
    // jsdom has no layout: model the visible boxes, with a collapsed link absent.
    for (const el of panel.querySelectorAll<HTMLElement>('*')) el.getClientRects = () => (el.id === 'closed' ? [] : [{}]) as unknown as DOMRectList;
    const last = document.getElementById('last')!;
    for (const id of ['details','team','lounge']) {
      for (const tab of panel.querySelectorAll<HTMLElement>('button[id]')) tab.tabIndex = tab.id === id ? 0 : -1;
      const selected = document.getElementById(id)!;
      selected.focus();
      const back = new dom.window.KeyboardEvent('keydown',{key:'Tab',shiftKey:true,cancelable:true});
      trapSheetTab(panel, back);
      assert.equal(back.defaultPrevented, true);
      assert.equal(document.activeElement, last);
      const forward = new dom.window.KeyboardEvent('keydown',{key:'Tab',cancelable:true});
      trapSheetTab(panel, forward);
      assert.equal(forward.defaultPrevented, true);
      assert.equal(document.activeElement, selected);
    }
  } finally {
    if (saved) Object.defineProperty(globalThis,'document',saved); else delete (globalThis as any).document;
    dom.window.close();
  }
});
