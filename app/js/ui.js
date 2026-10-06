// 화면 공통 도우미. app.js(라우터·페이지)와 sim.js(시뮬레이터)가 함께 쓴다.
import { lookup } from './data.js';

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 저장소를 쓸 수 없는 환경 */ } },
  raw(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  setRaw(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* noop */ } },
};
export const badge = (cls, t) => `<span class="badge b-${cls}">${esc(t)}</span>`;
export const VIRT = badge('virtual', '가상');
export const PUB = badge('public', '공공');
export const INTV = badge('interview', '인터뷰');
export const ASSUME = badge('hyp', '가정');
export const chip = (id) => `<button type="button" class="ev-chip${lookup(id) ? '' : ' bad'}" data-ref="${esc(id)}" aria-label="근거 ${esc(id)} 원문 보기">${esc(id)}</button>`;
export const chips = (ids) => `<span class="ev-chips">${ids.map(chip).join('')}</span>`;
export const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let toastTimer;
export function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3800);
}

// AI 답 표기
export const ACTION_LABEL = { check_physical_stock: '실물 확인 (선반·창고)', Q_0: '보류 (0팩)', Q_5: '5팩 주문', Q_10: '10팩 주문', order_open: '주문 (수량은 답하지 않음)', defer: '판단 유보', other: '후보 밖' };
export const qidOf = (a, qty) => (a === 'commit_choice' ? `Q_${qty ?? 0}` : a);
export const layerName = (l) => (l === 'B1' ? 'B1 · 인터뷰 없이' : l === 'P0' ? 'P0 · 인터뷰 근거' : l === 'P1' ? 'P1 · 인터뷰 + 그날 환경' : l.startsWith('P1-') ? `P1에서 ${l.slice(3)} 근거 뺌` : l);
export const SRC_KO = { interview: '인터뷰', scene: '그날 환경', observation: '화면에 보인 값', assumption: '추론', general_knowledge: '일반 상식' };
export const srcTag = (k) => `<span class="src-tag src-${esc(k)}">${esc(SRC_KO[k] || k)}</span>`;
export const FLAG_TEXT = {
  ids_given_without_interview: '인터뷰 자료 없이 근거 번호를 댔습니다',
  no_evidence_cited: '선택을 했지만 근거 번호가 없습니다',
  invalid_qty: '주문량이 선택지에 없습니다',
  action_not_allowed: '허용되지 않은 행동입니다',
  priorities_not_two: '중요하게 본 것이 두 가지가 아닙니다',
  no_factors: '판단 요인을 적지 않았습니다',
  interview_factor_without_ids: '인터뷰 요인이라면서 근거 번호가 없습니다',
  interview_factor_in_b1: '인터뷰 자료가 없는데 인터뷰 요인을 댔습니다',
  scene_factor_without_scene: '그날 환경 정보를 받지 않았는데 환경 요인을 댔습니다',
  output_reshaped: '답의 형식이 틀려 목록으로 펴서 읽었습니다',
};
export const flagText = (f) => {
  const k = f.replace(/^r\d+:/, '');
  if (FLAG_TEXT[k]) return FLAG_TEXT[k];
  if (k.startsWith('unknown_ids')) return `데이터에 없는 근거 번호: ${k.split(':').slice(1).join(':')}`;
  if (k.startsWith('cites_removed_id')) return `이번 실행에서 뺀 근거를 인용했습니다: ${k.split(':').slice(1).join(':')}`;
  return k;
};
export const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
export function downloadFile(name, text, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); URL.revokeObjectURL(a.href);
}
