import {EditorState} from '@codemirror/state';
import {syntaxTree, syntaxTreeAvailable} from '@codemirror/language';

export interface CompletionInput {prefix:string;suffix:string;title:string}

/** Fail closed when the host parser has not reached the insertion point. */
export function completionContext(state:EditorState,title:string):CompletionInput|null {
  if(state.selection.ranges.length!==1||!state.selection.main.empty||state.readOnly)return null;
  const at=state.selection.main.head;
  // The experiment completes phrases, not the middle of an ASCII word.
  if(/[A-Za-z0-9]$/.test(state.doc.sliceString(Math.max(0,at-1),at))&&/^[A-Za-z0-9]/.test(state.doc.sliceString(at,Math.min(state.doc.length,at+1))))return null;
  if(!syntaxTreeAvailable(state,at))return null;
  const tree=syntaxTree(state);
  if(!tree.length||tree.topNode.name==='')return null;
  for(const side of [-1,1] as const){
    let node=tree.resolveInner(at,side);
    for(;;){
      if(/(?:code|math|formula|link|url|image|hashtag|frontmatter|yaml|table|html|comment)/i.test(node.name))return null;
      if(!node.parent)break;node=node.parent;
    }
  }
  // Incomplete Markdown tokens and Obsidian-specific syntax may have no tree node yet.
  const before=state.doc.sliceString(0,at),line=state.doc.lineAt(at),left=state.doc.sliceString(line.from,at);
  const lines=before.split('\n');
  if(lines[0]?.trim()==='---'){
    const end=lines.slice(1).findIndex(v=>/^(?:---|\.\.\.)\s*$/.test(v));
    if(end<0)return null;
  }
  let fence='',displayMath=false;
  for(const value of lines){
    const marker=value.match(/^\s{0,3}(`{3,}|~{3,})/);
    if(marker){if(!fence)fence=marker[1];else if(marker[1][0]===fence[0]&&marker[1].length>=fence.length)fence='';}
    if(!fence&&/^\s*\$\$/.test(value))displayMath=!displayMath;
  }
  if(fence||displayMath)return null;
  const prose=line.text.replace(/^\s*(?:>\s*)+/,'');
  if(/`|\$|\[|\]|\||<|>/.test(prose)||/(?:^|\s)#[^\s]*$/.test(left))return null;
  if(/^\s*(?:#{1,6}\s|[-*_]{3,}\s*$)/.test(line.text)||!left.trim())return null;
  return {prefix:state.doc.sliceString(Math.max(0,at-3000),at),suffix:state.doc.sliceString(at,Math.min(state.doc.length,at+1000)),title:title.slice(0,200)};
}

/** Finalize once before display; accepting a candidate never rewrites its text. */
export function normalizeCompletion(text:string,input?:CompletionInput):string|null {
  const result=text;
  if(!result.trim()||/[\n\r\u2028\u2029\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(result)||result.includes('```')||result.length>500)return null;
  if(input&&((/[A-Za-z0-9]$/.test(input.prefix)&&/^[A-Za-z0-9]/.test(result))||(/[A-Za-z0-9]$/.test(result)&&/^[A-Za-z0-9]/.test(input.suffix))))return null;
  return result;
}
