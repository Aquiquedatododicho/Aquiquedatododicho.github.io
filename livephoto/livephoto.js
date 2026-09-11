/*
 * LiveFoto - utilidades para convertir un par JPG + MOV en una Live Photo.
 *
 * Una Live Photo de Apple es una foto (JPG/HEIC) y un video (MOV) que comparten
 * el mismo "content identifier" (un UUID):
 *   - En el JPG va dentro del MakerNote de Apple (etiqueta 0x0011) del EXIF.
 *   - En el MOV va como clave QuickTime "com.apple.quicktime.content.identifier"
 *     en el atom moov/meta, y ademas el MOV lleva una pista de metadatos con
 *     la clave "com.apple.quicktime.still-image-time" que marca en que instante
 *     del video esta la foto fija.
 *
 * Este archivo no depende de nada y se puede usar en el navegador (window.LivePhoto)
 * o en Node (module.exports).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LivePhoto = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var textEncoder = new TextEncoder();

  /* ------------------------------------------------------------------ */
  /* Utilidades de bytes                                                 */
  /* ------------------------------------------------------------------ */

  function concat(parts) {
    var n = 0, i;
    for (i = 0; i < parts.length; i++) n += parts[i].length;
    var out = new Uint8Array(n), o = 0;
    for (i = 0; i < parts.length; i++) { out.set(parts[i], o); o += parts[i].length; }
    return out;
  }
  function u8(v) { return new Uint8Array([v & 255]); }
  function u16(v) { return new Uint8Array([(v >>> 8) & 255, v & 255]); }
  function u32(v) { return new Uint8Array([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]); }
  function zeros(n) { return new Uint8Array(n); }
  function str(s) { return textEncoder.encode(s); }
  function pascal(s) { var b = str(s); return concat([u8(b.length), b]); }
  function readU16(b, o) { return (b[o] << 8) | b[o + 1]; }
  function readU32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
  function fourcc(b, o) { return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]); }

  function randomUUID() {
    var c = (typeof crypto !== 'undefined') ? crypto : null;
    if (c && c.randomUUID) return c.randomUUID().toUpperCase();
    var bytes = new Uint8Array(16);
    if (c && c.getRandomValues) c.getRandomValues(bytes);
    else for (var i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    var hex = Array.prototype.map.call(bytes, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    return (hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20)).toUpperCase();
  }

  function exifDate(d) {
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + ':' + p(d.getMonth() + 1) + ':' + p(d.getDate()) + ' ' +
      p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  /* ------------------------------------------------------------------ */
  /* EXIF (TIFF big-endian) para el JPG                                  */
  /* ------------------------------------------------------------------ */

  var TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 7: 1 };

  // entries: [{tag, type, data: Uint8Array}] ordenadas por tag.
  // base: offset (dentro del TIFF) donde empieza este IFD; los valores largos
  // se colocan justo despues de la tabla y se referencian con offset absoluto.
  function ifdLength(entries) {
    var n = 2 + entries.length * 12 + 4;
    entries.forEach(function (e) { if (e.data.length > 4) n += e.data.length + (e.data.length & 1); });
    return n;
  }
  function buildIfd(entries, base) {
    var table = [u16(entries.length)];
    var extra = [];
    var dataOffset = base + 2 + entries.length * 12 + 4;
    entries.forEach(function (e) {
      var count = e.data.length / TYPE_SIZE[e.type];
      table.push(u16(e.tag), u16(e.type), u32(count));
      if (e.data.length <= 4) {
        var inline = new Uint8Array(4); inline.set(e.data); table.push(inline);
      } else {
        table.push(u32(dataOffset));
        extra.push(e.data);
        dataOffset += e.data.length;
        if (e.data.length & 1) { extra.push(u8(0)); dataOffset++; }
      }
    });
    table.push(u32(0)); // no hay siguiente IFD
    return concat(table.concat(extra));
  }

  // MakerNote de Apple: cabecera "Apple iOS\0" + version (0x0001) + "MM" y
  // despues un IFD cuyos offsets son relativos al inicio del MakerNote.
  function buildAppleMakerNote(uuid) {
    var header = concat([str('Apple iOS'), u8(0), u16(1), str('MM')]); // 14 bytes
    var entries = [
      { tag: 0x0011, type: 2, data: concat([str(uuid), u8(0)]) } // ContentIdentifier
    ];
    return concat([header, buildIfd(entries, header.length)]);
  }

  function buildExifApp1(uuid, date) {
    var when = concat([str(exifDate(date || new Date())), u8(0)]); // 20 bytes

    var ifd0Entries = [
      { tag: 0x0132, type: 2, data: when },            // DateTime
      { tag: 0x8769, type: 4, data: u32(0) }           // ExifIFDPointer (se rellena luego)
    ];
    var ifd0Offset = 8;
    var exifOffset = ifd0Offset + ifdLength(ifd0Entries);
    ifd0Entries[1].data = u32(exifOffset);

    var exifEntries = [
      { tag: 0x9003, type: 2, data: when },            // DateTimeOriginal
      { tag: 0x9004, type: 2, data: when }             // DateTimeDigitized
    ];
    if (uuid) exifEntries.push({ tag: 0x927c, type: 7, data: buildAppleMakerNote(uuid) }); // MakerNote

    var tiff = concat([
      str('MM'), u16(0x002a), u32(ifd0Offset),
      buildIfd(ifd0Entries, ifd0Offset),
      buildIfd(exifEntries, exifOffset)
    ]);
    var payload = concat([str('Exif'), u16(0), tiff]);
    return concat([new Uint8Array([0xff, 0xe1]), u16(payload.length + 2), payload]);
  }

  // Separa la cabecera de un JPEG en sus segmentos APPn (los que van antes de
  // los datos de imagen) y clasifica Exif y XMP.
  function splitJpegHeader(jpeg) {
    if (!(jpeg[0] === 0xff && jpeg[1] === 0xd8)) throw new Error('El archivo no es un JPEG');
    var segs = { app0: [], exif: null, xmp: null, other: [] };
    var p = 2;
    while (p + 4 <= jpeg.length && jpeg[p] === 0xff && jpeg[p + 1] >= 0xe0 && jpeg[p + 1] <= 0xef) {
      var len = readU16(jpeg, p + 2);
      var seg = jpeg.subarray(p, p + 2 + len);
      if (jpeg[p + 1] === 0xe0) segs.app0.push(seg);
      else if (jpeg[p + 1] === 0xe1 && fourcc(jpeg, p + 4) === 'Exif') segs.exif = seg;
      else if (jpeg[p + 1] === 0xe1 && fourcc(jpeg, p + 4) === 'http') segs.xmp = seg;
      else segs.other.push(seg);
      p += 2 + len;
    }
    segs.rest = jpeg.subarray(p);
    return segs;
  }

  // Vuelve a montar el JPEG con el orden habitual: APP0 (JFIF), Exif, XMP, resto.
  function joinJpegHeader(segs) {
    var parts = [new Uint8Array([0xff, 0xd8])].concat(segs.app0);
    if (segs.exif) parts.push(segs.exif);
    if (segs.xmp) parts.push(segs.xmp);
    return concat(parts.concat(segs.other, [segs.rest]));
  }

  // Inserta (o sustituye) el segmento APP1 Exif en un JPEG. Si uuid es null no
  // se escribe el MakerNote de Apple (solo las fechas).
  function injectExif(jpeg, uuid, date) {
    var segs = splitJpegHeader(jpeg);
    segs.exif = buildExifApp1(uuid, date);
    return joinJpegHeader(segs);
  }

  /* ------------------------------------------------------------------ */
  /* Motion Photo (Android / Google Fotos)                               */
  /* ------------------------------------------------------------------ */

  // Una Motion Photo es un JPEG al que se le pega el MP4 al final. Un bloque
  // XMP dentro del JPEG (formato Motion Photo 1.0 de Google, Container/Item)
  // dice donde empieza el video y en que instante esta la foto fija. Ademas
  // envolvemos el video con el trailer SEF de Samsung, que es lo que hacen los
  // Galaxy: asi lo reconocen tanto Google Fotos como la galeria de Samsung.
  // La estructura replica la de la herramienta MotionPhoto2.
  function buildXmp(primaryPadding, videoItemLength, presentationUs) {
    var ts = presentationUs == null ? -1 : Math.max(0, Math.round(presentationUs));
    return '<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
      '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 5.1.0-jc003">' +
      '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
      '<rdf:Description rdf:about=""' +
      ' xmlns:GCamera="http://ns.google.com/photos/1.0/camera/"' +
      ' xmlns:Container="http://ns.google.com/photos/1.0/container/"' +
      ' xmlns:Item="http://ns.google.com/photos/1.0/container/item/"' +
      ' GCamera:MotionPhoto="1"' +
      ' GCamera:MotionPhotoVersion="1"' +
      ' GCamera:MotionPhotoPresentationTimestampUs="' + ts + '">' +
      '<Container:Directory><rdf:Seq>' +
      '<rdf:li rdf:parseType="Resource"><Container:Item Item:Mime="image/jpeg" Item:Semantic="Primary" Item:Length="0" Item:Padding="' + primaryPadding + '"/></rdf:li>' +
      '<rdf:li rdf:parseType="Resource"><Container:Item Item:Mime="video/mp4" Item:Semantic="MotionPhoto" Item:Length="' + videoItemLength + '" Item:Padding="0"/></rdf:li>' +
      '</rdf:Seq></Container:Directory>' +
      '</rdf:Description></rdf:RDF></x:xmpmeta>' +
      '<?xpacket end="w"?>';
  }

  // Trailer SEF de Samsung con el video dentro (etiqueta MotionPhoto_Data) y la
  // version (MotionPhoto_Version = mpv3), seguido del indice SEFH...SEFT.
  var SEF_DATA_ID = new Uint8Array([0x00, 0x00, 0x30, 0x0a]);
  var SEF_VERSION_ID = new Uint8Array([0x00, 0x00, 0x31, 0x0a]);
  function le32(v) { return new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]); }
  function readLe32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

  function buildSamsungTrailer(mp4) {
    var dataName = str('MotionPhoto_Data'), versionName = str('MotionPhoto_Version');
    var dataTag = concat([SEF_DATA_ID, le32(dataName.length), dataName, mp4]);
    var versionTag = concat([SEF_VERSION_ID, le32(versionName.length), versionName, str('mpv3')]);
    // Los offsets se miden hacia atras desde el inicio de SEFH.
    var index = concat([
      str('SEFH'), le32(107), le32(2),
      SEF_DATA_ID, le32(dataTag.length + versionTag.length), le32(dataTag.length),
      SEF_VERSION_ID, le32(versionTag.length), le32(versionTag.length)
    ]);
    var sefh = concat([index, le32(index.length), str('SEFT')]);
    return {
      bytes: concat([dataTag, versionTag, sefh]),
      videoOffset: 4 + 4 + dataName.length // bytes de cabecera antes del MP4
    };
  }

  var XMP_HEADER = 'http://ns.adobe.com/xap/1.0/';

  // Inserta (o sustituye) el segmento APP1 XMP detras de los APPn existentes.
  function injectXmp(jpeg, xmpText) {
    if (!(jpeg[0] === 0xff && jpeg[1] === 0xd8)) throw new Error('El archivo no es un JPEG');
    var payload = concat([str(XMP_HEADER), u8(0), str(xmpText)]);
    if (payload.length + 2 > 0xffff) throw new Error('XMP demasiado grande');
    var app1 = concat([new Uint8Array([0xff, 0xe1]), u16(payload.length + 2), payload]);
    var parts = [jpeg.subarray(0, 2)];
    var p = 2;
    while (p + 4 <= jpeg.length && jpeg[p] === 0xff && jpeg[p + 1] >= 0xe0 && jpeg[p + 1] <= 0xef) {
      var len = readU16(jpeg, p + 2);
      var isXmp = jpeg[p + 1] === 0xe1 && fourcc(jpeg, p + 4) === 'http';
      if (!isXmp) parts.push(jpeg.subarray(p, p + 2 + len));
      p += 2 + len;
    }
    parts.push(app1, jpeg.subarray(p));
    return concat(parts);
  }

  function buildMotionPhoto(jpeg, mp4, presentationUs) {
    var trailer = buildSamsungTrailer(mp4);
    // Para Google: el "item" de video empieza en el ftyp del MP4 y llega hasta
    // el final del archivo; el padding del item principal es la cabecera SEF
    // que hay entre la imagen y el MP4.
    var xmp = buildXmp(trailer.videoOffset, trailer.bytes.length - trailer.videoOffset, presentationUs);
    return concat([injectXmp(jpeg, xmp), trailer.bytes]);
  }

  function readMotionPhotoInfo(bytes) {
    var info = { xmp: null, primaryPadding: null, videoItemLength: null, presentationUs: null, video: null, samsung: false };
    var segs = splitJpegHeader(bytes);
    if (segs.xmp) info.xmp = new TextDecoder().decode(segs.xmp.subarray(4 + XMP_HEADER.length + 1));
    if (info.xmp) {
      var m = info.xmp.match(/Item:Semantic="Primary" Item:Length="0" Item:Padding="(\d+)"/);
      if (m) info.primaryPadding = parseInt(m[1], 10);
      m = info.xmp.match(/Item:Semantic="MotionPhoto" Item:Length="(\d+)"/);
      if (m) info.videoItemLength = parseInt(m[1], 10);
      m = info.xmp.match(/MotionPhotoPresentationTimestampUs="(-?\d+)"/);
      if (m) info.presentationUs = parseInt(m[1], 10);
    }
    // Trailer Samsung: ...SEFH [indice] [tamano indice] SEFT
    var n = bytes.length;
    if (fourcc(bytes, n - 4) === 'SEFT') {
      var indexLen = readLe32(bytes, n - 8), sefhStart = n - 8 - indexLen;
      if (fourcc(bytes, sefhStart) === 'SEFH') {
        var count = readLe32(bytes, sefhStart + 8);
        for (var i = 0; i < count; i++) {
          var e = sefhStart + 12 + i * 12;
          if (bytes[e + 2] === 0x30 && bytes[e + 3] === 0x0a) {
            var tagStart = sefhStart - readLe32(bytes, e + 4), tagLen = readLe32(bytes, e + 8);
            var nameLen = readLe32(bytes, tagStart + 4);
            info.video = bytes.subarray(tagStart + 8 + nameLen, tagStart + tagLen);
            info.samsung = true;
          }
        }
      }
    }
    if (!info.video && info.videoItemLength) info.video = bytes.subarray(n - info.videoItemLength);
    return info;
  }

  /* ------------------------------------------------------------------ */
  /* QuickTime / MOV                                                     */
  /* ------------------------------------------------------------------ */

  function box(type, parts) { var body = concat(parts); return concat([u32(8 + body.length), str(type), body]); }
  function boxRaw(typeBytes, parts) { var body = concat(parts); return concat([u32(8 + body.length), typeBytes, body]); }
  function fullBox(type, version, flags, parts) {
    return box(type, [new Uint8Array([version, (flags >>> 16) & 255, (flags >>> 8) & 255, flags & 255])].concat(parts));
  }

  // Devuelve la lista de atoms hijos en el rango [start, end).
  function listBoxes(bytes, start, end) {
    var out = [], p = start;
    while (p + 8 <= end) {
      var size = readU32(bytes, p), hdr = 8;
      var type = fourcc(bytes, p + 4);
      if (size === 1) {
        if (readU32(bytes, p + 8) !== 0) throw new Error('Atom demasiado grande');
        size = readU32(bytes, p + 12); hdr = 16;
      } else if (size === 0) {
        size = end - p;
      }
      if (size < hdr || p + size > end) throw new Error('Atom "' + type + '" corrupto');
      out.push({ type: type, start: p, size: size, hdr: hdr, end: p + size });
      p += size;
    }
    return out;
  }

  function parseMvhd(bytes, b) {
    var o = b.start + b.hdr, version = bytes[o];
    if (version === 1) {
      return { version: 1, ctime: readU32(bytes, o + 8), mtime: readU32(bytes, o + 16),
        timescale: readU32(bytes, o + 20), duration: readU32(bytes, o + 28), nextTrackOffset: o + 108 };
    }
    return { version: 0, ctime: readU32(bytes, o + 4), mtime: readU32(bytes, o + 8),
      timescale: readU32(bytes, o + 12), duration: readU32(bytes, o + 16), nextTrackOffset: o + 96 };
  }

  var UNITY_MATRIX = concat([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]);

  // Pista de metadatos temporizados con un unico sample "still-image-time".
  function buildStillImageTrack(opt) {
    var tkhd = fullBox('tkhd', 0, 0x000003, [
      u32(opt.ctime), u32(opt.mtime), u32(opt.trackId), u32(0),
      u32(opt.stillTime + opt.sampleDuration),
      zeros(8), u16(0), u16(0), u16(0), u16(0), UNITY_MATRIX, u32(0), u32(0)
    ]);

    var elstEntries = [];
    if (opt.stillTime > 0) elstEntries.push(u32(opt.stillTime), u32(0xffffffff), u32(0x00010000)); // hueco vacio
    elstEntries.push(u32(opt.sampleDuration), u32(0), u32(0x00010000));
    var edts = box('edts', [fullBox('elst', 0, 0, [u32(elstEntries.length / 3)].concat(elstEntries))]);

    var mdhd = fullBox('mdhd', 0, 0, [u32(opt.ctime), u32(opt.mtime), u32(opt.timescale), u32(opt.sampleDuration), u16(0x55c4), u16(0)]);
    var hdlr = fullBox('hdlr', 0, 0, [str('mhlr'), str('meta'), str('appl'), u32(0), u32(0), pascal('Core Media Metadata')]);

    var gmhd = box('gmhd', [fullBox('gmin', 0, 0, [u16(0x40), u16(0x8000), u16(0x8000), u16(0x8000), u16(0), u16(0)])]);
    var dataHdlr = fullBox('hdlr', 0, 0, [str('dhlr'), str('url '), str('appl'), u32(0), u32(0), pascal('DataHandler')]);
    var dinf = box('dinf', [fullBox('dref', 0, 0, [u32(1), fullBox('url ', 0, 1, [])])]);

    var keyd = box('keyd', [str('mdta'), str('com.apple.quicktime.still-image-time')]);
    var dtyp = box('dtyp', [u32(0), u32(65)]); // 65 = entero de 8 bits con signo
    var keys = box('keys', [boxRaw(u32(1), [keyd, dtyp])]);
    var mebx = box('mebx', [zeros(6), u16(1), keys]);

    var stbl = box('stbl', [
      fullBox('stsd', 0, 0, [u32(1), mebx]),
      fullBox('stts', 0, 0, [u32(1), u32(1), u32(opt.sampleDuration)]),
      fullBox('stsc', 0, 0, [u32(1), u32(1), u32(1), u32(1)]),
      fullBox('stsz', 0, 0, [u32(0), u32(1), u32(opt.sampleSize)]),
      fullBox('stco', 0, 0, [u32(1), u32(opt.sampleOffset)])
    ]);
    var minf = box('minf', [gmhd, dataHdlr, dinf, stbl]);
    var mdia = box('mdia', [mdhd, hdlr, minf]);
    return box('trak', [tkhd, edts, mdia]);
  }

  // Atom moov/meta al estilo QuickTime (sin version/flags) con claves mdta.
  function buildMetaAtom(pairs) {
    var hdlr = fullBox('hdlr', 0, 0, [u32(0), str('mdta'), u32(0), u32(0), u32(0), u8(0)]);
    var keyEntries = [u32(pairs.length)];
    var items = [];
    pairs.forEach(function (kv, i) {
      keyEntries.push(box('mdta', [str(kv[0])]));
      items.push(boxRaw(u32(i + 1), [box('data', [u32(1), u32(0), str(kv[1])])]));
    });
    return box('meta', [hdlr, fullBox('keys', 0, 0, keyEntries), box('ilst', items)]);
  }

  /**
   * Convierte un MOV normal (con el atom moov al final, como lo escribe ffmpeg)
   * en un MOV de Live Photo:
   *   - anade moov/meta con com.apple.quicktime.content.identifier = uuid
   *   - anade una pista de metadatos con com.apple.quicktime.still-image-time
   *     situada en stillTimeSec (segundos desde el inicio del video)
   */
  function addLivePhotoMetadata(bytes, uuid, stillTimeSec) {
    var top = listBoxes(bytes, 0, bytes.length);
    var moov = null;
    top.forEach(function (b) { if (b.type === 'moov') moov = b; });
    if (!moov) throw new Error('El video no tiene atom moov');
    if (moov.end !== bytes.length) throw new Error('El atom moov debe ser el ultimo del archivo');

    var children = listBoxes(bytes, moov.start + moov.hdr, moov.end);
    var mvhdBox = null;
    children.forEach(function (b) { if (b.type === 'mvhd') mvhdBox = b; });
    if (!mvhdBox) throw new Error('El video no tiene atom mvhd');
    var mvhd = parseMvhd(bytes, mvhdBox);
    var trackId = readU32(bytes, mvhd.nextTrackOffset);

    // Sample de metadatos: [tamano][id de clave local][valor int8 = 0]
    var sample = concat([u32(9), u32(1), u8(0)]);
    var newMdat = box('mdat', [sample]);
    var sampleOffset = moov.start + 8; // el nuevo mdat ocupa el sitio del viejo moov

    var stillTime = Math.round((stillTimeSec || 0) * mvhd.timescale);
    stillTime = Math.max(0, Math.min(stillTime, Math.max(mvhd.duration - 1, 0)));
    var sampleDuration = Math.max(mvhd.duration - stillTime, 1);

    var trak = buildStillImageTrack({
      ctime: mvhd.ctime, mtime: mvhd.mtime, trackId: trackId, timescale: mvhd.timescale,
      stillTime: stillTime, sampleDuration: sampleDuration,
      sampleSize: sample.length, sampleOffset: sampleOffset
    });

    var meta = buildMetaAtom([['com.apple.quicktime.content.identifier', uuid]]);

    var parts = [];
    children.forEach(function (b) {
      if (b.type === 'udta' || b.type === 'meta') return; // los reemplazamos por nuestro meta
      var chunk = bytes.slice(b.start, b.end);
      if (b.type === 'mvhd') {
        var rel = mvhd.nextTrackOffset - b.start;
        chunk.set(u32(trackId + 1), rel);
      }
      parts.push(chunk);
    });
    parts.push(trak, meta);
    var newMoov = box('moov', parts);

    return concat([bytes.subarray(0, moov.start), newMdat, newMoov]);
  }

  /* ------------------------------------------------------------------ */
  /* Lectura (para verificar)                                            */
  /* ------------------------------------------------------------------ */

  function readMovInfo(bytes) {
    var info = { brand: null, contentIdentifier: null, tracks: [] };
    var top = listBoxes(bytes, 0, bytes.length);
    top.forEach(function (b) {
      if (b.type === 'ftyp') info.brand = fourcc(bytes, b.start + 8);
      if (b.type !== 'moov') return;
      listBoxes(bytes, b.start + b.hdr, b.end).forEach(function (c) {
        if (c.type === 'trak') info.tracks.push(describeTrack(bytes, c));
        if (c.type === 'meta') {
          var start = c.start + 8;
          if (fourcc(bytes, start + 4) !== 'hdlr') start += 4; // variante ISO con version/flags
          var keys = [], values = [];
          listBoxes(bytes, start, c.end).forEach(function (m) {
            if (m.type === 'keys') listBoxes(bytes, m.start + 16, m.end).forEach(function (k) {
              keys.push(new TextDecoder().decode(bytes.subarray(k.start + 8, k.end)));
            });
            if (m.type === 'ilst') listBoxes(bytes, m.start + 8, m.end).forEach(function (it) {
              var idx = readU32(bytes, it.start + 4);
              var data = listBoxes(bytes, it.start + 8, it.end)[0];
              values[idx - 1] = new TextDecoder().decode(bytes.subarray(data.start + 16, data.end));
            });
          });
          keys.forEach(function (k, i) { if (k === 'com.apple.quicktime.content.identifier') info.contentIdentifier = values[i]; });
        }
      });
    });
    return info;
  }

  function describeTrack(bytes, trak) {
    var t = { handler: null, keys: [] };
    listBoxes(bytes, trak.start + 8, trak.end).forEach(function (a) {
      if (a.type !== 'mdia') return;
      listBoxes(bytes, a.start + 8, a.end).forEach(function (m) {
        if (m.type === 'hdlr') t.handler = fourcc(bytes, m.start + 16);
        if (m.type !== 'minf') return;
        listBoxes(bytes, m.start + 8, m.end).forEach(function (mi) {
          if (mi.type !== 'stbl') return;
          listBoxes(bytes, mi.start + 8, mi.end).forEach(function (s) {
            if (s.type !== 'stsd') return;
            listBoxes(bytes, s.start + 16, s.end).forEach(function (entry) {
              t.format = entry.type;
              if (entry.type !== 'mebx') return;
              listBoxes(bytes, entry.start + 16, entry.end).forEach(function (k) {
                if (k.type !== 'keys') return;
                listBoxes(bytes, k.start + 8, k.end).forEach(function (key) {
                  listBoxes(bytes, key.start + 8, key.end).forEach(function (d) {
                    if (d.type === 'keyd') t.keys.push(new TextDecoder().decode(bytes.subarray(d.start + 12, d.end)));
                  });
                });
              });
            });
          });
        });
      });
    });
    return t;
  }

  function readJpegContentIdentifier(jpeg) {
    var p = 2;
    while (p + 4 <= jpeg.length && jpeg[p] === 0xff && jpeg[p + 1] >= 0xe0 && jpeg[p + 1] <= 0xef) {
      var len = readU16(jpeg, p + 2);
      if (jpeg[p + 1] === 0xe1 && fourcc(jpeg, p + 4) === 'Exif') {
        var tiff = jpeg.subarray(p + 10, p + 2 + len);
        var exifIfd = findTag(tiff, readU32(tiff, 4), 0x8769);
        if (!exifIfd) return null;
        var maker = findTag(tiff, readU32(tiff, exifIfd + 8), 0x927c);
        if (!maker) return null;
        var mn = tiff.subarray(readU32(tiff, maker + 8), readU32(tiff, maker + 8) + readU32(tiff, maker + 4));
        if (new TextDecoder().decode(mn.subarray(0, 9)) !== 'Apple iOS') return null;
        var id = findTag(mn, 14, 0x0011);
        if (!id) return null;
        var count = readU32(mn, id + 4), off = readU32(mn, id + 8);
        return new TextDecoder().decode(mn.subarray(off, off + count - 1));
      }
      p += 2 + len;
    }
    return null;
  }
  function findTag(tiff, ifdOffset, tag) {
    var n = readU16(tiff, ifdOffset);
    for (var i = 0; i < n; i++) {
      var e = ifdOffset + 2 + i * 12;
      if (readU16(tiff, e) === tag) return e;
    }
    return null;
  }

  return {
    randomUUID: randomUUID,
    buildExifApp1: buildExifApp1,
    injectExif: injectExif,
    addLivePhotoMetadata: addLivePhotoMetadata,
    buildMotionPhoto: buildMotionPhoto,
    readMotionPhotoInfo: readMotionPhotoInfo,
    readMovInfo: readMovInfo,
    readJpegContentIdentifier: readJpegContentIdentifier
  };
});
