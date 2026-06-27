/**
 * mitsubishi-config — 三菱 PLC 连接配置节点
 * 保存 IP、端口、帧格式等连接参数，供 mitsubishi-read 节点引用
 */
module.exports = function (RED) {
  function MitsubishiConfigNode(config) {
    RED.nodes.createNode(this, config);
    this.name = config.name || 'PLC-1';
    this.host = config.host || '192.168.1.10';
    this.port = parseInt(config.port, 10) || 5007;
    this.frame = config.frame || '3E';
    this.networkNo = parseInt(config.networkNo, 10) || 0;
    this.stationNo = parseInt(config.stationNo, 10) || 0;
    this.timeout = parseInt(config.timeout, 10) || 3000;
    this.maxRetries = parseInt(config.maxRetries, 10);
    if (isNaN(this.maxRetries)) this.maxRetries = 2;
    this.retryInterval = parseInt(config.retryInterval, 10);
    if (isNaN(this.retryInterval)) this.retryInterval = 300;
  }
  RED.nodes.registerType('mitsubishi-config', MitsubishiConfigNode);
};
