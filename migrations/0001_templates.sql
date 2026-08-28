-- 알려진 양식 저장소.
--
-- 여기에 들어가는 것: 구조 해시, 뼈대, 필드의 위치와 이름, 라벨 문구, 값의 해시.
-- 여기에 들어가지 않는 것: 원본 HWPX, 이미지, 본문 전체, 필드에 적힌 실제 값.
--
-- 같은 뼈대라도 양식이 개정될 수 있어 (structure_hash, version) 으로 세대를 나눈다.
-- 조회는 항상 같은 해시의 최신 version 부터 본다.

CREATE TABLE IF NOT EXISTS templates (
  id              TEXT    PRIMARY KEY,
  structure_hash  TEXT    NOT NULL,
  version         INTEGER NOT NULL,
  name            TEXT    NOT NULL,
  -- 뼈대 문자열. 구조가 정말 같은지 해시 충돌과 무관하게 다시 확인할 때 쓴다.
  skeleton        TEXT    NOT NULL,
  paragraph_count INTEGER NOT NULL,
  table_count     INTEGER NOT NULL,
  image_count     INTEGER NOT NULL,
  -- TemplateField[] / TemplateAnchor[] 를 JSON 으로. D1 에 배열 타입이 없다.
  fields_json     TEXT    NOT NULL,
  anchors_json    TEXT    NOT NULL,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_templates_hash_version
  ON templates (structure_hash, version);

-- 조회 경로: 해시로 후보를 뽑아 최신 version 부터 라벨을 대조한다.
CREATE INDEX IF NOT EXISTS idx_templates_lookup
  ON templates (structure_hash, version DESC);
