"""Сборка словаря для подбора иероглифов по пиньиню: data/zh-dict.json.gz

Источники (MIT):
  https://github.com/fxsjy/jieba            -> jieba/dict.txt (слова и частоты)
  https://github.com/mozillazg/pinyin-data  -> pinyin.txt (чтения иероглифов)
  https://github.com/mozillazg/phrase-pinyin-data -> large_pinyin.txt (чтения слов)

  git clone --depth 1 <репозитории> в /tmp/jieba, /tmp/pyd, /tmp/ppd
  python build_zh_dict.py 20 && gzip -9 -c zh-dict.json > zh-dict.json.gz
Аргумент — минимальная частота слова (20 ≈ 82 тыс. слов, 1 МБ в gzip).
"""
import re, json, math, unicodedata, collections, sys
def plain(p):
    s=unicodedata.normalize('NFD',p); s=''.join(c for c in s if not unicodedata.combining(c) or c=='̈')
    return unicodedata.normalize('NFC',s).replace('ü','v').replace('ü','v')
char={}
for l in open('/tmp/pyd/pinyin.txt',encoding='utf8'):
    m=re.match(r'U\+([0-9A-F]+): ([^#]+)#',l)
    if m: char[chr(int(m.group(1),16))]=[x.strip() for x in m.group(2).split(',')]
phrase={}
for l in open('/tmp/ppd/large_pinyin.txt',encoding='utf8'):
    if l.startswith('#') or ':' not in l: continue
    w,p=l.split(':',1); phrase[w.strip()]=p.strip()
cjk=re.compile(r'^[一-鿿]{1,4}$')
MINF=int(sys.argv[1]) if len(sys.argv)>1 else 3
d=collections.defaultdict(list); n=0
for l in open('/tmp/jieba/jieba/dict.txt',encoding='utf8'):
    w,f,*_=l.split(); f=int(f)
    if not cjk.match(w) or (f<MINF and len(w)>1 and '盲' not in w): continue
    lf=round(math.log(f),2)
    if len(w)==1:
        for k,r in enumerate(char.get(w,[])): d[plain(r)].append([w,round(lf-(0 if k==0 else 4),2),r])  # редкие чтения — штраф
    else:
        p=phrase.get(w)
        if not p:
            if not all(c in char for c in w): continue
            p=' '.join(char[c][0] for c in w)
        if len(p.split())!=len(w): continue
        d[' '.join(plain(x) for x in p.split())].append([w,lf,p])
    n+=1
total=sum(int(l.split()[1]) for l in open('/tmp/jieba/jieba/dict.txt',encoding='utf8'))
print('log total', round(math.log(total),2))
out={k:sorted(v,key=lambda x:-x[1])[:6] for k,v in d.items()}
s=json.dumps(out,ensure_ascii=False,separators=(',',':'))
open('zh-dict.json','w',encoding='utf8').write(s)
import gzip; print('words',n,'keys',len(out),'MB',round(len(s.encode())/1e6,2),'gz',round(len(gzip.compress(s.encode()))/1e6,2))
