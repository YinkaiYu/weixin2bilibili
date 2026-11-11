import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyImportMessages,noticeFields,importFailure} from '../extension/lib/import-notices.js';

test('ordinary platform adaptation is information while semantic fallback and unknown messages need review',()=>{
  const result=noticeFields(classifyImportMessages([
    '上下标已转换为 B 站原生行内公式，可在 B 站公式编辑器中继续修改。',
    '正文已按 B 站支持的字号调整（14→13px）。实际字号、字重和段间距由 B 站控制。',
    'B 站原生段落没有已验证的两端对齐值，将使用默认对齐；文字内容保留。',
    '已清除 2 处外链（保留链接文字和图片）。',
    '含强调样式或彩色文字的图注已保留为图片下方正文，避免 B 站原生纯文字图注丢失加粗、颜色或装饰。',
    '平台返回未知差异',
  ]));
  assert.equal(result.info.length,4);
  assert.equal(result.warnings.length,2);
  assert.equal(result.errors.length,0);
});

test('explicit severities take priority and identical messages keep their highest severity',()=>{
  const result=classifyImportMessages([{severity:'info',message:'同一内容'}],[{severity:'error',message:'同一内容'}],[{severity:'warning',message:'同一内容'}]);
  assert.deepEqual(result,[{severity:'error',message:'同一内容'}]);
});

test('classifying a real failure preserves its diagnostic and recovery fields',()=>{
  const cause=new Error('server failure'),original=new Error('第 2 张图片上传失败',{cause});
  Object.assign(original,{code:4125014,draftUrl:'saved-draft',saveUncertain:true,imageDiagnostic:{index:2}});
  const error=importFailure(original);
  assert.equal(error,original);assert.equal(error.cause,cause);assert.equal(error.code,4125014);
  assert.equal(error.draftUrl,'saved-draft');assert.equal(error.saveUncertain,true);assert.deepEqual(error.imageDiagnostic,{index:2});
  assert.equal(error.severity,'error');assert.deepEqual(error.errors,['第 2 张图片上传失败']);
});
