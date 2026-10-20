import { SOLAR_SYSTEM, STAR_SYSTEMS, getBody, getSystemGroup } from "./solar-system";
import type { BodyId, SystemGroupId } from "./solar-system";

export type MapSelection = { group: SystemGroupId; parent?: BodyId; galaxy?: boolean };
export type MapTarget = { body: BodyId; group?: SystemGroupId };
export const MAP_SYSTEMS: { id: SystemGroupId; name: string; english: string; description: string; type: string; position: [number, number, number] }[] = [
  { id: "solar", name: "太阳系", english: "SOLAR SYSTEM", type: "我们的起点", position: [0, 0, 0], description: "一颗恒星，八颗行星，以及围绕它们的万千世界。从蓝色地球出发，沿着轨道认识我们的宇宙邻居。" },
  { id: "alpha-centauri", name: "半人马座 α", english: "ALPHA CENTAURI", type: "三合星系统", position: [-7, 0.4, -5], description: "离太阳最近的恒星邻居。南门二 A、B 与遥远的比邻星共同组成三合星系统；比邻星的行星外观与尺度为探索示意。" },
  { id: "barnard", name: "巴纳德星", english: "BARNARD’S STAR", type: "红矮星系统", position: [7, -0.4, -6], description: "一颗安静的红矮星与四颗紧凑的短周期行星。轨道与周期参考观测，行星半径和地表为概念示意，大气状况未知。" },
  { id: "betelgeuse", name: "参宿四", english: "BETELGEUSE", type: "红超巨星", position: [-9, 0.8, 6], description: "猎户座肩上的红超巨星。巨大的对流胞在光球表面缓慢翻涌；当前航区仅建立恒星，尚未添加行星或伴星。" },
  { id: "echo-rift", name: "回声裂隙", english: "ECHO RIFT", type: "原创虚构航区", position: [9, 0.9, 5], description: "蓝白脉冲星照亮气态巨行星、潮汐海洋卫星与碎裂残骸。这里的距离、尺度、轨道及地貌均为虚构游戏设定。" },
  { id: "black-hole", name: "暗渊", english: "GARGANTUA", type: "虚构黑洞航区", position: [1, -0.5, 10], description: "围绕暗渊黑洞的吸积盘与引力透镜景观。光带与阴影采用艺术近似；本航区没有可登陆的固体天体。" },
];
export const mapSystem = (group: SystemGroupId) => MAP_SYSTEMS.find(system => system.id === group)!;
export const mapPrimary = (group: SystemGroupId): BodyId => STAR_SYSTEMS.find(system => system.groupId === group)!.primaryStar as BodyId;
export const mapBodies = (group: SystemGroupId) => SOLAR_SYSTEM.filter(body => getSystemGroup(body.id) === group);
export const mapChildren = (id: BodyId) => SOLAR_SYSTEM.filter(body => body.parentId === id);
export const mapSatellites = (id: BodyId) => mapChildren(id).filter(body => body.kind !== "station");
export const isMapStar = (id: BodyId) => id === "sun" || getBody(id).kind === "star" || getBody(id).kind === "black-hole";
