import play from 'play-dl';
const [hit] = await play.search('BENNETT Vois sur ton chemin DJ Holanda MONTAGEM CORAL Remix', { source: { youtube: 'video' }, limit: 1 });
console.log(hit?.url, '|', hit?.title);
