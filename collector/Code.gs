// 录入僧回传：开了「发数据给方丈」的录入僧，把识别记录、缩小的照片、改过的格子 POST 到这里，存进网盘「录入僧回传」。
// 只收不给：谁拿到网址也只能往里放东西，看不到、改不了、删不掉；同名的已经有了就不再存（重发不重复）。
// 权限只要 drive.file：只碰这个接口自己建的文件夹和文件，网盘里别的东西它看不见。
var TOKEN = 'qslab-luruseng-1';
var MAX = 8 * 1024 * 1024;           // 一次最多 8MB
var DAY_MAX = 100 * 1024 * 1024;     // 一天最多收 100MB，防人拿网址乱灌
var ALL_MAX = 3 * 1024 * 1024 * 1024; // 总共最多收 3GB：满了就不收，等方丈清理（网盘满了邮件都收不了）
var ROOT_NAME = '录入僧回传';
var FOLDER = 'application/vnd.google-apps.folder';

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    var body = e && e.postData ? e.postData.contents : '';
    if (!body || body.length > MAX) return reply({ok: false, error: 'size'});
    var req = JSON.parse(body);
    if (req.token !== TOKEN) return reply({ok: false, error: 'token'});
    lock.waitLock(25000);
    var dir = folder(folder(root(), clean(req.machine) || 'unknown'), clean(req.run) || 'misc');
    var name = clean(req.name) || ('item_' + Date.now() + '.json');
    if (find(dir, name, false)) return reply({ok: true, dup: true});
    if (!budget(body.length)) return reply({ok: false, error: 'full'});
    var blob = req.kind === 'photo'
      ? Utilities.newBlob(Utilities.base64Decode(req.data), 'image/jpeg', name)
      : Utilities.newBlob(JSON.stringify(req.payload, null, 1), 'application/json', name);
    Drive.Files.create({name: name, parents: [dir]}, blob);
    return reply({ok: true});
  } catch (err) {
    return reply({ok: false, error: String(err)});
  } finally {
    lock.releaseLock();
  }
}

function doGet() {
  return reply({ok: true, hello: '录入僧回传'});
}

function root() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('ROOT');
  if (id) {
    try {
      if (!Drive.Files.get(id, {fields: 'id,trashed'}).trashed) return id;
    } catch (e) {}
  }
  id = Drive.Files.create({name: ROOT_NAME, mimeType: FOLDER}).id;
  props.setProperty('ROOT', id);
  return id;
}

function folder(parent, name) {
  return find(parent, name, true) || Drive.Files.create({name: name, mimeType: FOLDER, parents: [parent]}).id;
}

function find(parent, name, isFolder) {
  var q = "'" + parent + "' in parents and name = '" + name.replace(/'/g, "\\'") + "' and trashed = false";
  q += isFolder ? " and mimeType = '" + FOLDER + "'" : " and mimeType != '" + FOLDER + "'";
  var r = Drive.Files.list({q: q, fields: 'files(id)', pageSize: 1});
  return r.files && r.files.length ? r.files[0].id : null;
}

function budget(n) {
  var props = PropertiesService.getScriptProperties();
  var day = Utilities.formatDate(new Date(), 'Asia/Singapore', 'yyyy-MM-dd');
  var used = props.getProperty('DAY') === day ? Number(props.getProperty('USED') || 0) : 0;
  var all = Number(props.getProperty('ALL') || 0);
  if (used + n > DAY_MAX || all + n > ALL_MAX) return false;
  props.setProperties({DAY: day, USED: String(used + n), ALL: String(all + n)});
  return true;
}

function clean(s) {
  return String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 80);
}

function reply(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
