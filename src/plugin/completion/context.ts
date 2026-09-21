import {EditorState} from '@codemirror/state';
import {syntaxTree, syntaxTreeAvailable} from '@codemirror/language';

export interface CompletionInput {prefix:string;suffix:string;title:string}

function openInlineSyntax(left:string):boolean {
  let ticks=0,inlineMath=false,brackets=0,linkTarget=0,html=false;
  for(let i=0;i<left.length;i++){
    const char=left[i];
    if(char==='\\'){i++;continue;}
    if(char==='`'){
      let end=i+1;while(left[end]==='`')end++;
      const count=end-i;if(!ticks)ticks=count;else if(ticks===count)ticks=0;
      i=end-1;continue;
    }
    if(ticks)continue;
    if(char==='$'){
      if(left[i+1]==='$'){i++;continue;}
      inlineMath=!inlineMath;continue;
    }
    if(inlineMath)continue;
    if(char==='[')brackets++;
    else if(char===']'){
      brackets=Math.max(0,brackets-1);
      if(!brackets&&left[i+1]==='('){linkTarget=1;i++;}
    }else if(linkTarget&&char==='(')linkTarget++;
    else if(linkTarget&&char===')')linkTarget--;
    else if(char==='<')html=true;
    else if(char==='>')html=false;
  }
  return !!(ticks||inlineMath||brackets||linkTarget||html);
}

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
  let bodyStart=0;
  if(lines[0]?.trim()==='---'){
    const end=lines.slice(1).findIndex(v=>/^(?:---|\.\.\.)\s*$/.test(v));
    if(end<0)return null;
    bodyStart=lines.slice(0,end+2).join('\n').length+1;
  }
  // Mask parsed code/link/HTML before scanning incomplete tokens. Delimiters inside
  // a closed inline code span or fenced block must not affect later prose.
  const mask=(kinds:RegExp)=>{
    const parts:string[]=[];let copied=0;
    tree.iterate({to:at,enter(node){
      if(!kinds.test(node.name))return;
      const from=Math.max(copied,node.from),to=Math.min(at,node.to);
      if(to>from){parts.push(before.slice(copied,from),before.slice(from,to).replace(/[^\n]/g,' '));copied=to;}
      return false;
    }});
    parts.push(before.slice(copied));return parts.join('');
  };
  const masked=mask(/(?:code|link|url|image|html|comment|frontmatter|yaml)/i);
  let displayMath=false;
  for(let i=bodyStart;i<masked.length;i++){
    if(masked[i]==='\\'){i++;continue;}
    if(masked[i]==='$'&&masked[i+1]==='$'){displayMath=!displayMath;i++;}
  }
  if(displayMath)return null;
  // A parsed reference-style [label] can be followed by an unfinished (target,
  // so keep link punctuation for the incomplete-token check.
  const prose=mask(/(?:code|html|comment|frontmatter|yaml)/i).slice(line.from).replace(/^\s*(?:>\s*)+/,'');
  if(openInlineSyntax(prose)||/\|/.test(line.text)||/(?:^|\s)#[^\s]*$/.test(left))return null;
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
