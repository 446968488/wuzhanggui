// 本地存储层：IndexedDB 封装（物品 / 资金账户 / 借贷 / 盘点快照 / 出入库日志 / 资金日志 / 人情账 / 建议交流 / 设置）
// 纯前端、无后端，数据存于本机浏览器。app=物掌柜(StuffManage)
const DB = (function () {
  const DB_NAME = 'stuffmanage';
  const DB_VERSION = 7;
  let db = null;

  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('items')) d.createObjectStore('items', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('accounts')) d.createObjectStore('accounts', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('loans')) d.createObjectStore('loans', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('snapshots')) d.createObjectStore('snapshots', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('stockLogs')) d.createObjectStore('stockLogs', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('accountLogs')) d.createObjectStore('accountLogs', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('favors')) d.createObjectStore('favors', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('persons')) d.createObjectStore('persons', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('feedbacks')) d.createObjectStore('feedbacks', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('settings')) d.createObjectStore('settings', { keyPath: 'key' });
        if (!d.objectStoreNames.contains('pots')) d.createObjectStore('pots', { keyPath: 'id' });
      };
      req.onsuccess = (e) => { db = e.target.result; resolve(db); };
      req.onerror = (e) => reject(e.target.error);
    });
  }

  function store(name, mode) { return db.transaction(name, mode).objectStore(name); }

  function put(name, val) {
    return new Promise((res, rej) => {
      const r = store(name, 'readwrite').put(val);
      r.onsuccess = () => res(val);
      r.onerror = (e) => rej(e.target.error);
    });
  }
  function getAll(name) {
    return new Promise((res, rej) => {
      const r = store(name, 'readonly').getAll();
      r.onsuccess = () => res(r.result || []);
      r.onerror = (e) => rej(e.target.error);
    });
  }
  function del(name, id) {
    return new Promise((res, rej) => {
      const r = store(name, 'readwrite').delete(id);
      r.onsuccess = () => res();
      r.onerror = (e) => rej(e.target.error);
    });
  }

  return { open, put, getAll, del };
})();
