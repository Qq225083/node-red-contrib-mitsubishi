/**
 * mitsubishi-read — 三菱 MC Protocol 3E/4E 读取节点 v2.0
 *
 * 独立使用: 节点表格配置点位 → inject触发 → 输出eng值
 * 集成使用: msg.tags 传入覆盖节点配置
 *
 * 变换: engValue = rawValue * slope + offset
 * 输出: msg.payload.data[tagId] = {rawValue, engValue, quality, ts}
 */
module.exports = function (RED) {
  var net = require('net');

  // ===== MC 软元件代码映射 =====
  var MC_DEVICE_CODES = {
    'D': 0xA8, 'W': 0xB4, 'X': 0x9C, 'Y': 0x9D,
    'M': 0x90, 'L': 0x92, 'B': 0xA0, 'R': 0xAF
  };
  var BIT_DEVICES = { 'X': true, 'Y': true, 'M': true, 'L': true, 'B': true };

  // ===== MC 错误码映射 =====
  var MC_ERROR_CODES = {
    0xC050: 'CPU busy', 0xC051: 'Device not supported', 0xC052: 'Address out of range',
    0xC053: 'Batch size out of range', 0xC054: 'Write protect error',
    0xC055: 'Remote operation error', 0xC056: 'File not found', 0xC057: 'File name error',
    0xC059: 'Points out of range', 0xC05B: 'CPU type mismatch', 0xC05C: 'Remote password error',
    0xC05F: 'CPU module error', 0xC061: 'Monitor timer timeout',
    0xC06F: 'ASCII code error', 0xC070: 'Frame length error',
    0xC0D0: 'PLC not running', 0x4004: '4E: Device not supported',
    0x401A: '4E: Address out of range', 0x4028: '4E: Points out of range'
  };
  function mcErrorText(code) {
    return MC_ERROR_CODES[code] || ('Unknown MC error 0x' + code.toString(16).toUpperCase());
  }

  function clampInt(v, def, min, max) {
    var n = parseInt(v, 10);
    if (isNaN(n)) n = def;
    return Math.max(min, Math.min(n, max));
  }

  // ===== 帧构造 =====
  function build3EFrame(startAddr, wordCount, stationNo, regType, networkNo) {
    var deviceCode = MC_DEVICE_CODES[regType] || 0xA8;
    var buf = Buffer.alloc(21);
    buf[0] = 0x50; buf[1] = 0x00;
    buf[2] = networkNo || 0; buf[3] = 0xFF; buf[4] = 0xFF; buf[5] = 0x03;
    buf[6] = stationNo || 0; buf[7] = 0x0C; buf[8] = 0x00;
    buf[9] = 0x10; buf[10] = 0x00;
    buf[11] = 0x01; buf[12] = 0x04; buf[13] = 0x00; buf[14] = 0x00;
    buf[15] = startAddr & 0xFF; buf[16] = (startAddr >> 8) & 0xFF;
    buf[17] = (startAddr >> 16) & 0xFF;
    buf[18] = deviceCode;
    buf.writeUInt16LE(wordCount, 19);
    return buf;
  }

  function build4EFrame(startAddr, wordCount, stationNo, regType, networkNo, serialNo) {
    var deviceCode = MC_DEVICE_CODES[regType] || 0xA8;
    var hasSN = (serialNo !== 0);
    var buf = Buffer.alloc(hasSN ? 24 : 22);
    buf[0] = 0x54; buf[1] = 0x00;
    buf[2] = networkNo || 0; buf[3] = 0xFF; buf[4] = 0xFF; buf[5] = 0x03;
    buf[6] = stationNo || 0;
    buf[7] = hasSN ? 0x0F : 0x0D; buf[8] = 0x00;
    buf[9] = 0x10; buf[10] = 0x00;
    var off = 11;
    if (hasSN) { buf[off] = serialNo & 0xFF; buf[off + 1] = (serialNo >> 8) & 0xFF; off += 2; }
    buf[off] = 0x01; buf[off + 1] = 0x04; off += 2;
    buf[off] = 0x00; buf[off + 1] = 0x00; off += 2;
    buf.writeUInt32LE(startAddr, off); off += 4;
    buf[off] = deviceCode; off += 1;
    buf.writeUInt16LE(wordCount, off);
    return buf;
  }

  // ===== 响应解析 =====
  function parseMCResponse(buf, startAddr, regType, frameType, sentSN) {
    if (!buf || buf.length < 11) return { err: 'Buffer too short' };
    var subheader = (buf[0] === 0xD0) ? 0x50 : ((buf[0] === 0xD4) ? 0xD4 : 0);
    if (subheader === 0) return { err: 'Invalid subheader' };

    var endCode = buf.readUInt16LE(9);
    if (endCode !== 0) return { mcError: endCode, mcErrorText: mcErrorText(endCode) };

    var dataLen = buf.readUInt16LE(7) - ((frameType === '4E') ? 4 : 2);
    if (dataLen < 0 || dataLen > 2000) return { err: 'Bad dataLen: ' + dataLen };

    var dataStart = (frameType === '4E') ? 13 : 11;
    if (frameType === '4E' && sentSN > 0 && buf.length >= 13) {
      if (buf.readUInt16LE(11) !== sentSN) return { err: 'SerialNo mismatch' };
    }

    if (buf.length < dataStart + dataLen) return { err: 'Incomplete frame' };

    var result = {};
    if (BIT_DEVICES[regType]) {
      for (var w = 0; w < dataLen / 2; w++) {
        var wordVal = buf.readUInt16LE(dataStart + w * 2);
        for (var b = 0; b < 16; b++) {
          result[regType + (startAddr + w * 16 + b)] = (wordVal >> b) & 1;
        }
      }
    } else {
      for (var i = 0; i < dataLen / 2; i++) {
        result[regType + (startAddr + i)] = buf.readInt16LE(dataStart + i * 2);
      }
    }
    return result;
  }

  // ===== 斜率偏移变换 =====
  function applyTransform(rawValue, tagDef) {
    if (rawValue === null || rawValue === undefined) return null;
    var slope = parseFloat(tagDef.slope || tagDef.transformSlopeA || 1);
    var offset = parseFloat(tagDef.offset || tagDef.transformOffsetB || 0);
    if (isNaN(slope)) slope = 1;
    if (isNaN(offset)) offset = 0;
    var eng = rawValue * slope + offset;
    return parseFloat(eng.toFixed(4));
  }

  // ===== 主节点 =====
  function MitsubishiReadNode(config) {
    RED.nodes.createNode(this, config);
    var node = this;

    node.plcConfig = RED.nodes.getNode(config.plc);
    if (!node.plcConfig) {
      node.error('未关联 PLC 配置节点');
      return;
    }
    node.serialNo = parseInt(config.serialNo, 10) || 0;

    // 解析节点表格配置的默认点位
    var configTags = [];
    try { configTags = JSON.parse(config.tags || '[]'); } catch (e) { configTags = []; }

    node.on('input', function (msg) {
      var plc = node.plcConfig;

      // === 读取点位: msg.tags → msg.payload.tags → 节点表格配置 ===
      var rawTags = msg.tags || (msg.payload && msg.payload.tags);
      if (!rawTags || (Array.isArray(rawTags) && rawTags.length === 0)) {
        rawTags = configTags;
      }
      if (!Array.isArray(rawTags)) rawTags = [rawTags];
      var tags = rawTags;

      // === 校验并清洗标签 ===
      var validTags = [];
      for (var i = 0; i < tags.length; i++) {
        var t = tags[i];
        var rt = t.regType || 'D';
        if (!MC_DEVICE_CODES[rt]) {
          if (rt) node.warn('[MC] Unknown regType: ' + rt + ', using D');
          rt = 'D';
        }
        // 地址: 兼容数字和 "D100" 格式
        var rawAddr = (t.addr !== undefined) ? t.addr : (t.regAddr || t.tag_address || t.registerAddress || '');
        if (typeof rawAddr === 'string') rawAddr = String(rawAddr).replace(/\D/g, '');
        var addr = parseInt(rawAddr, 10);
        if (isNaN(addr) || addr < 0) {
          node.warn('[MC] Invalid addr for tag ' + (t.id || t.name || ('#' + i)));
          continue;
        }
        // ID: 优先用 t.id，其次 t.name，最后自生成
        var tagId = t.id || t.name || (rt + addr);
        validTags.push({
          id: String(tagId),
          regType: rt,
          addr: addr,
          dataType: t.dataType || 'INT16',
          slope: t.slope || t.transformSlopeA || 1,
          offset: t.offset || t.transformOffsetB || 0,
          name: t.name || (rt + addr)
        });
      }

      if (validTags.length === 0) {
        node.status({ fill: 'grey', shape: 'dot', text: '0 valid tags' });
        return;
      }

      // === 参数 ===
      var timeout = clampInt(plc.timeout, 3000, 500, 30000);
      var maxRetries = clampInt(plc.maxRetries, 2, 0, 10);
      var retryInterval = clampInt(plc.retryInterval, 300, 50, 10000);
      var frameType = plc.frame || '3E';
      var stationNo = plc.stationNo || 0;
      var networkNo = plc.networkNo || 0;
      var roundStart = Date.now();

      // === 模拟模式 ===
      var SIM_MODE = false;
      try { SIM_MODE = RED.settings.mcSimulationMode || false; } catch (e) {}

      if (SIM_MODE) {
        var simOut = {};
        validTags.forEach(function (t) {
          var raw = BIT_DEVICES[t.regType] ? (Math.random() > 0.5 ? 1 : 0) : Math.floor(Math.random() * 1000);
          simOut[t.id] = { rawValue: raw, engValue: applyTransform(raw, t), quality: 0, ts: new Date().toISOString() };
        });
        var devId = plc.name || (plc.host + ':' + plc.port);
        msg.payload = { success: true, deviceId: devId, data: simOut, error: null, roundTimeMs: Date.now() - roundStart };
        node.status({ fill: 'green', shape: 'dot', text: 'SIM ' + validTags.length + ' tags' });
        node.send(msg);
        return;
      }

      // === 去重: 同 regType + addr 保留最后一个 ===
      var seen = {};
      var deduped = [];
      for (var di = validTags.length - 1; di >= 0; di--) {
        var dt = validTags[di];
        var dk = dt.regType + '|' + dt.addr;
        if (!seen[dk]) { seen[dk] = true; deduped.unshift(dt); }
      }
      if (deduped.length < validTags.length) {
        node.warn('[MC] Deduped ' + (validTags.length - deduped.length) + ' duplicate tags');
      }
      validTags = deduped;

      // === 聚类分组 ===
      var byRegType = {};
      validTags.forEach(function (t) {
        if (!byRegType[t.regType]) byRegType[t.regType] = [];
        byRegType[t.regType].push(t);
      });

      var groups = [];
      Object.keys(byRegType).forEach(function (rt) {
        var sorted = byRegType[rt].slice().sort(function (a, b) { return a.addr - b.addr; });
        var cluster = [sorted[0]];
        for (var i = 1; i < sorted.length; i++) {
          var gap = sorted[i].addr - cluster[cluster.length - 1].addr;
          if (gap <= 20 && cluster.length < 50) {
            cluster.push(sorted[i]);
          } else {
            groups.push({ regType: rt, tags: cluster });
            cluster = [sorted[i]];
          }
        }
        if (cluster.length > 0) groups.push({ regType: rt, tags: cluster });
      });

      if (groups.length === 0) {
        node.status({ fill: 'red', shape: 'ring', text: 'no groups' });
        msg.payload = { success: false, data: {}, error: 'No valid register groups' };
        node.send(msg);
        return;
      }

      // === 全局锁 (按 host:port) ===
      var lockKey = 'edge_mc_lock_' + plc.host + '_' + plc.port;
      if (!global._mcLocks) global._mcLocks = {};
      if (global._mcLocks[lockKey] && (Date.now() - global._mcLocks[lockKey] < 60000)) {
        node.status({ fill: 'yellow', shape: 'dot', text: 'busy' });
        setTimeout(function () { node.send(msg); }, 200);
        return;
      }
      global._mcLocks[lockKey] = Date.now();

      // === 顺序处理 groups ===
      var allRaw = {};   // raw values from PLC
      var hasFailed = false;
      var firstError = '';
      var currentSN = node.serialNo;

      function processGroup(gi) {
        if (gi >= groups.length) {
          // 全部完成 → 构建输出（含斜率偏移变换）
          var output = {};
          validTags.forEach(function (t) {
            var entry = allRaw[t.id];
            if (entry) {
              output[t.id] = {
                rawValue: entry.rawValue,                    // PLC 原始 int16
                engValue: applyTransform(entry.convertedValue, t), // 解码值 × slope + offset
                quality: entry.quality,
                ts: entry.ts,
                regType: t.regType
              };
            }
          });
          msg.payload = {
            success: !hasFailed,
            deviceId: plc.name || (plc.host + ':' + plc.port),
            data: output,
            error: hasFailed ? firstError : null,
            driverType: 'driver-mc-protocol',
            plcIp: plc.host,
            plcPort: plc.port,
            roundTimeMs: Date.now() - roundStart
          };
          node.status({
            fill: hasFailed ? 'red' : 'green',
            shape: 'dot',
            text: (plc.name || plc.host) + ' ' + Object.keys(output).length + ' vals ' + (Date.now() - roundStart) + 'ms'
          });
          delete global._mcLocks[lockKey];
          node.send(msg);
          return;
        }

        var grp = groups[gi];
        var addrs = grp.tags.map(function (t) { return t.addr; });
        var startA = addrs[0];
        var isBit = BIT_DEVICES[grp.regType] || false;
        if (isBit) startA = startA - (startA % 16);

        var wordCount;
        if (isBit) {
          wordCount = Math.ceil((addrs[addrs.length - 1] - startA + 1) / 16);
        } else {
          wordCount = addrs[addrs.length - 1] - startA + 1;
        }

        // 字数上限 + 自动拆包
        var MAX_WORDS = isBit ? 15360 : 960;
        if (wordCount > MAX_WORDS) {
          var newGroups = [];
          var ss = 0;
          while (ss < grp.tags.length) {
            var se = ss;
            while (se < grp.tags.length && (grp.tags[se].addr - grp.tags[ss].addr) < MAX_WORDS) se++;
            newGroups.push({ regType: grp.regType, tags: grp.tags.slice(ss, se) });
            ss = se;
          }
          groups.splice.apply(groups, [gi, 1].concat(newGroups));
          setTimeout(function () { processGroup(gi); }, 0);
          return;
        }

        function attemptGroup(attempt) {
          if (attempt > maxRetries) {
            hasFailed = true;
            if (!firstError) firstError = 'MC read failed for ' + grp.regType + startA;
            setTimeout(function () { processGroup(gi + 1); }, 0);
            return;
          }

          var sentSN = (frameType === '4E' && currentSN > 0) ? currentSN : 0;
          if (frameType === '4E' && currentSN > 0) currentSN = (currentSN + 1) & 0xFFFF;

          var client = new net.Socket();
          var buf = Buffer.alloc(0);
          var resolved = false;
          client.setTimeout(timeout);

          client.connect(plc.port, plc.host, function () {
            try {
              var frame = (frameType === '4E')
                ? build4EFrame(startA, wordCount, stationNo, grp.regType, networkNo, sentSN)
                : build3EFrame(startA, wordCount, stationNo, grp.regType, networkNo);
              client.write(frame);
            } catch (e) {
              node.warn('[MC] connect error: ' + e.message);
              if (!resolved) { resolved = true; try { client.destroy(); } catch (e2) {} }
              setTimeout(function () { attemptGroup(attempt + 1); }, retryInterval);
            }
          });

          client.on('data', function (chunk) {
            try {
              buf = Buffer.concat([buf, chunk]);
              var hdrLen = (frameType === '4E') ? 13 : 11;
              if (!resolved && buf.length >= hdrLen) {
                var dataLen = buf.readUInt16LE(7) - ((frameType === '4E') ? 4 : 2);
                if (dataLen < 0 || dataLen > 2000) {
                  resolved = true; try { client.destroy(); } catch (e) {}
                  setTimeout(function () { attemptGroup(attempt + 1); }, retryInterval);
                  return;
                }
                if (buf.length >= hdrLen + dataLen) {
                  resolved = true;
                  var raw = parseMCResponse(buf, startA, grp.regType, frameType, sentSN);

                  if (raw && raw.mcError) {
                    hasFailed = true;
                    if (!firstError) firstError = '[PLC 0x' + raw.mcError.toString(16).toUpperCase() + '] ' + raw.mcErrorText;
                    _destroyedByUs = true; try { client.destroy(); } catch (e) {}
                    setTimeout(function () { processGroup(gi + 1); }, 0);
                  } else if (raw && !raw.err) {
                    grp.tags.forEach(function (t) {
                      var key = grp.regType + t.addr;
                      var originRv = raw[key];           // PLC 原始 int16
                      var cv = originRv;                 // 解码后的值
                      var q = 0;
                      if (originRv === undefined || originRv === null) { q = 2; originRv = null; cv = null; }
                      else if (!isBit) {
                        var dt = t.dataType || 'INT16';
                        if (dt === 'UINT16') { if (cv < 0) cv += 65536; }
                        else if (dt === 'INT32' || dt === 'UINT32' || dt === 'FLOAT32') {
                          var adj = raw[grp.regType + (t.addr + 1)];
                          if (adj === undefined || adj === null) { q = 2; originRv = null; cv = null; }
                          else {
                            var hi = originRv, lo = adj;
                            var combined = (hi << 16) | (lo & 0xFFFF);
                            if (dt === 'INT32') cv = (combined > 0x7FFFFFFF) ? combined - 0x100000000 : combined;
                            else if (dt === 'UINT32') cv = combined >>> 0;
                            else if (dt === 'FLOAT32') {
                              var b32 = Buffer.alloc(4);
                              b32.writeInt16LE(hi, 0); b32.writeInt16LE(lo, 2);
                              cv = parseFloat(b32.readFloatLE(0).toFixed(4));
                            }
                          }
                        }
                      }
                      allRaw[t.id] = { rawValue: originRv, convertedValue: cv, quality: q, ts: new Date().toISOString() };
                    });
                    _destroyedByUs = true; try { client.destroy(); } catch (e) {}
                    setTimeout(function () { processGroup(gi + 1); }, 0);
                  } else {
                    _destroyedByUs = true; try { client.destroy(); } catch (e) {}
                    setTimeout(function () { attemptGroup(attempt + 1); }, retryInterval);
                  }
                }
              }
            } catch (e) {
              node.warn('[MC] data handler error: ' + e.message);
              if (!resolved) { resolved = true; try { client.destroy(); } catch (e2) {} }
              setTimeout(function () { processGroup(gi + 1); }, 0);
            }
          });

          client.on('timeout', function () {
            if (resolved) return;
            resolved = true;
            try { client.destroy(); } catch (e) {}
            setTimeout(function () { attemptGroup(attempt + 1); }, retryInterval);
          });

          client.on('error', function () {
            if (resolved) return;
            resolved = true;
            try { client.destroy(); } catch (e) {}
            setTimeout(function () { attemptGroup(attempt + 1); }, retryInterval);
          });

          var _destroyedByUs = false;
          client.on('close', function () {
            if (_destroyedByUs) return;  // 我们自己关的，不做错误处理
            if (!resolved) {
              resolved = true;
              if (buf.length === 0) {
                hasFailed = true;
                if (!firstError) firstError = '[NETWORK] TCP closed (no data)';
                setTimeout(function () { processGroup(gi + 1); }, 0);
              } else {
                // 收到部分数据但帧不完整，重试
                setTimeout(function () { attemptGroup(attempt + 1); }, retryInterval);
              }
            }
          });
        }
        attemptGroup(0);
      }

      try {
        processGroup(0);
      } catch (e) {
        node.warn('[MC] Exception: ' + e.message);
        delete global._mcLocks[lockKey];
        msg.payload = { success: false, data: {}, error: e.message };
        node.status({ fill: 'red', shape: 'ring', text: 'exception' });
        node.send(msg);
      }
    });
  }

  RED.nodes.registerType('mitsubishi-read', MitsubishiReadNode);
};
