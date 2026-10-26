'use strict';
const required = {
  forms: ['text', 'number', 'date', 'textarea', 'checkbox', 'radio', 'select', 'pgm_checked', 'pgm_value', 'pgm_multi'],
  editor: ['ce_typing', 'term_keys', 'selection', 'feed_append', 'feed_text'],
  media: ['src', 'srcset', 'picture', 'poster', 'image_set_bg', 'media_play', 'media_seek', 'media_pause'],
  layout: ['fixed_top', 'inner_scroll', 'modal', 'dialog'],
  style: ['link_css', 'import_css', 'adopted_change', 'late_link', 'body_inherit'],
  canvas: ['canvas2d_report', 'canvas2d_node', 'webgl_node', 'webgl_offscreen_gated', 'webgl_anim_fps', 'table_rows', 'table_click', 'term_keys'],
  dnd: ['dnd_drop', 'touch', 'focus_sync', 'self_heal'],
  vlist: ['vlist_updates', 'vlist_rows', 'vlist_shiftdiff'],
  xiframe: ['xframe_srcdoc', 'xframe_content', 'xframe_noscript', 'xframe_dynamic'],
  cshadow: ['cshadow_pre_visible', 'cshadow_post', 'cshadow_interact', 'cshadow_interact_visual'],
  audio: ['audio_playing', 'audio_unmuted', 'audio_progress', 'audio_pause'],
};
function accepts(out) {
  const names = required[out.case];
  return !!(names && !out.error && out.checks && names.every(name => out.checks[name] === true)
    && Object.values(out.checks).every(value => value === true));
}
module.exports = { accepts };
