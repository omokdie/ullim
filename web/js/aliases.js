/*
 * 가수 이름 한글 ↔ 영어 (가사 찾기용)
 * LRCLIB 에는 'IU' 처럼 영어 이름만 있는 곡이 많아서, 음악 파일 태그의 '아이유' 로는 못 찾는 경우가 있다.
 * 같은 사람/그룹의 다른 표기를 한 줄에 적는다. 비교는 소문자 · 글자와 숫자만 남겨서 한다.
 */
export const ARTIST_ALIASES = [
  ['아이유', 'IU'], ['방탄소년단', 'BTS', 'Bangtan Boys'], ['블랙핑크', 'BLACKPINK'], ['트와이스', 'TWICE'],
  ['레드벨벳', 'Red Velvet'], ['뉴진스', 'NewJeans'], ['에스파', 'aespa'], ['아이브', 'IVE'], ['르세라핌', 'LE SSERAFIM'],
  ['세븐틴', 'SEVENTEEN'], ['엑소', 'EXO'], ['빅뱅', 'BIGBANG'], ['소녀시대', "Girls' Generation", 'SNSD'], ['샤이니', 'SHINee'],
  ['동방신기', 'TVXQ'], ['슈퍼주니어', 'Super Junior'], ['있지', 'ITZY'], ['스트레이 키즈', 'Stray Kids'], ['엔시티 127', 'NCT 127'],
  ['엔시티 드림', 'NCT DREAM'], ['엔시티', 'NCT'], ['투모로우바이투게더', 'TOMORROW X TOGETHER', 'TXT'], ['에이티즈', 'ATEEZ'],
  ['마마무', 'MAMAMOO'], ['여자아이들', '(G)I-DLE', 'GIDLE', 'I-DLE', '아이들'], ['오마이걸', 'OH MY GIRL'],
  ['볼빨간사춘기', 'BOL4', 'Bolbbalgan4'], ['악뮤', 'AKMU', '악동뮤지션', 'Akdong Musician'], ['데이식스', 'DAY6'], ['잔나비', 'JANNABI'],
  ['십센치', '10cm'], ['태연', 'TAEYEON'], ['윤하', 'YOUNHA'], ['성시경', 'Sung Si Kyung'], ['임영웅', 'Lim Young Woong'],
  ['지코', 'ZICO'], ['헤이즈', 'Heize'], ['청하', 'CHUNG HA'], ['선미', 'SUNMI'], ['화사', 'Hwa Sa'], ['제니', 'JENNIE'],
  ['로제', 'ROSÉ'], ['지수', 'JISOO'], ['리사', 'LISA'], ['정국', 'Jung Kook'], ['지민', 'Jimin'], ['백예린', 'Yerin Baek'],
  ['폴킴', 'Paul Kim'], ['이하이', 'LEE HI'], ['거미', 'GUMMY'], ['씨엔블루', 'CNBLUE'], ['에픽하이', 'Epik High'],
  ['다비치', 'DAVICHI'], ['케이윌', 'K.Will'], ['멜로망스', 'MeloMance'], ['이무진', 'Lee Mujin'], ['박효신', 'Park Hyo Shin'],
  ['김범수', 'Kim Bum Soo'], ['에일리', 'Ailee'], ['태양', 'TAEYANG'], ['지드래곤', 'G-DRAGON'], ['씨스타', 'SISTAR'],
  ['에이핑크', 'Apink'], ['여자친구', 'GFRIEND'], ['위너', 'WINNER'], ['아이콘', 'iKON'], ['몬스타엑스', 'MONSTA X'],
  ['더보이즈', 'THE BOYZ'], ['엔하이픈', 'ENHYPEN'], ['케플러', 'Kep1er'], ['엔믹스', 'NMIXX'], ['키스오브라이프', 'KISS OF LIFE'],
  ['베이비몬스터', 'BABYMONSTER'], ['보이넥스트도어', 'BOYNEXTDOOR'], ['투어스', 'TWS'], ['라이즈', 'RIIZE'],
  ['제로베이스원', 'ZEROBASEONE', 'ZB1'], ['프로미스나인', 'fromis_9'], ['우주소녀', 'WJSN', 'Cosmic Girls'], ['나연', 'NAYEON'],
  ['윤종신', 'Yoon Jong Shin'], ['이소라', 'Lee So Ra'], ['장범준', 'Jang Beom June'], ['버스커 버스커', 'Busker Busker'],
  ['이적', 'Lee Juck'], ['자우림', 'Jaurim'], ['국카스텐', 'Guckkasten'], ['쏜애플', 'THORNAPPLE'], ['혁오', 'HYUKOH'],
  ['새소년', 'SE SO NEON'], ['실리카겔', 'Silica Gel'], ['너드커넥션', 'Nerd Connection'], ['QWER', '큐더블유이알'],
];
