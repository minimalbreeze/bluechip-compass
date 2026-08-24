/* ============================================================================
   market.js — 시장 국면 진단기 + 구조적 테마
   ----------------------------------------------------------------------------
   왜 이렇게 만들었나 (중요):

   이 앱은 빌드 도구도 서버도 없는 정적 웹앱이다. "오늘의 시황"을 파일에
   적어 넣으면 배포한 다음 날부터 틀린 정보가 되고, 초보자는 그 낡은 문장을
   최신 정보로 믿는다. 정세는 하루 만에 뒤집히는데 파일은 그대로 있는 게
   가장 위험하다.

   그래서 시황을 "적어주는" 대신 **판정**한다.
     · 워크플로(scripts/judge-regime.mjs)가 실제 수치로 5개 항목을 판정해
       live.json 의 regime 에 넣는다 — 판정마다 한국어 근거를 함께 낸다
     · 이 파일의 규칙 엔진이 그 판정을 받아 국면 라벨 + 배분 조정 +
       이번 달 행동을 내놓는다
   그러면 파일이 낡아도 결과는 항상 오늘 기준이 된다.

   처음에는 사용자가 다이얼 5개를 직접 맞추게 했다. 배우는 효과는 있었지만
   "매일 확인하세요"라는 요구 자체가 부담이라 결국 아무도 확인하지 않았다.
   지금은 자동이 기본이고, 직접 고치는 길만 남겨 뒀다(앱의 "직접 고치기").

   DEFAULTS 는 **판정을 못 받아왔을 때만** 쓰이는 비상 출발값이다. `asOf` 는
   그 값을 사람이 마지막으로 확인한 날짜이고, 고칠 때는 반드시 같이 고칠 것.
   ========================================================================== */

window.BCMarket = (function () {
  'use strict';

  /* ── 다이얼 정의 ────────────────────────────────────────────────
     tilt: 선택 시 배분에 더할 값 (%p). cash는 현금, sat은 위성.
           코어는 나머지로 자동 계산되므로 여기 넣지 않는다.
     비대칭 설계: 위험을 키우는 방향(+sat)보다 줄이는 방향(+cash)의
     절댓값을 크게 뒀다. 초보자에게는 기회를 놓치는 것보다 크게 다치는
     쪽이 훨씬 비싸기 때문이다.                                        */
  var DIALS = [
    {
      key: 'rates', icon: '🏦', title: '금리는 어느 방향인가?',
      why: '금리는 모든 자산 가격의 중력이다. 내려가면 주식이 가벼워지고, 올라가면 무거워진다.',
      where: [
        { label: '한국은행 기준금리', url: 'https://www.bok.or.kr/portal/singl/baseRate/list.do?dataSeCd=01&menuNo=200643', for: 'kr' },
        { label: 'CME FedWatch (미국 금리 전망)', url: 'https://www.cmegroup.com/markets/interest-rates/cme-fedwatch-tool.html', for: 'us' }
      ],
      options: [
        { v: 'cut',  label: '내리는 중', hint: '최근 인하했거나 시장이 인하를 강하게 기대',
          tilt: { cash: -5, sat: +3 },
          force: {"up": "금리 인하 — 유동성이 풀리고 할인율이 낮아진다"},
          read: '유동성이 풀리는 국면. 성장주와 장기채가 먼저 반응한다. 다만 <b>"경기가 나빠서 내리는 인하"</b>인지 확인해야 한다 — 그 경우엔 주식이 먼저 빠진다.' },
        { v: 'hold', label: '멈춰 있음', hint: '몇 달째 동결, 다음 방향이 불확실',
          tilt: { cash: 0, sat: 0 },
          force: {},
          read: '방향이 없을 때는 예측이 아니라 <b>규칙</b>으로 버티는 구간. 정해둔 적립을 그대로 실행하는 게 최선이다.' },
        { v: 'hike', label: '올리는 중', hint: '최근 인상했거나 인상 압력이 커짐',
          tilt: { cash: +8, sat: -5 },
          force: {"down": "금리 인상 — 할인율이 올라 이익이 먼 회사부터 깎인다"},
          read: '할인율이 올라가 <b>이익이 먼 미래에 있는 회사일수록 크게 깎인다</b>. 지금 현금을 버는 회사, 배당 주는 회사가 상대적으로 강해진다.' }
      ]
    },
    {
      key: 'growth', icon: '📉', title: '경기는 어떤가?',
      why: '금리가 가격을 정하면, 경기는 기업의 이익 자체를 정한다.',
      where: [
        { label: '통계청 경기종합지수', url: 'https://kostat.go.kr/', for: 'kr' },
        { label: 'FRED 실업률·ISM', url: 'https://fred.stlouisfed.org/series/UNRATE', for: 'us' }
      ],
      options: [
        { v: 'expand', label: '괜찮음', hint: '고용 견조, 기업 실적 상향',
          tilt: { cash: -3, sat: +3 },
          force: {"up": "경기 확장 — 기업 이익 추정치가 올라간다"},
          read: '이익이 늘어나는 국면. 경기민감주(반도체·자동차·철강)가 상대적으로 유리하다.' },
        { v: 'slow',   label: '둔화 중', hint: '고용 둔화, 실적 전망 하향',
          tilt: { cash: +4, sat: -3 },
          force: {"down": "경기 둔화 — 이익 추정치가 깎이는 구간"},
          read: '이익 추정치가 깎이는 구간. <b>필수소비재·통신·헬스케어처럼 경기와 무관한 매출</b>이 방어력을 갖는다.' },
        { v: 'reces',  label: '침체 신호', hint: '실업 급증, 역성장 우려',
          tilt: { cash: +10, sat: -8 },
          force: {"down": "침체 신호 — 이익과 고용이 동시에 흔들린다"},
          read: '역설적이지만 <b>장기 투자자에게는 싸게 사는 구간</b>이다. 단, 실직 위험이 있는 사람은 현금이 먼저다. 투자금보다 생활비 방어가 우선.' }
      ]
    },
    {
      key: 'valuation', icon: '⚖️', title: '지금 시장은 비싼가?',
      why: '좋은 회사를 비싸게 사면 몇 년을 기다린다. 가격은 수익률의 절반이다.',
      where: [
        { label: 'KRX 지수 PER/PBR', url: 'http://data.krx.co.kr/', for: 'kr' },
        { label: 'S&P500 실적·밸류에이션', url: 'https://www.spglobal.com/spdji/en/indices/equity/sp-500/', for: 'us' }
      ],
      options: [
        { v: 'cheap', label: '싼 편', hint: '지수 PER/PBR이 과거 평균보다 낮음',
          tilt: { cash: -6, sat: +2 },
          force: {"up": "낮은 밸류에이션 — 기대가 이미 낮게 깔려 있다"},
          read: '기대가 낮게 깔린 구간. <b>이럴 때 산 돈이 장기 수익률의 대부분을 만든다.</b> 다만 싼 데는 이유가 있으니 그 이유가 회복 가능한지 본다.' },
        { v: 'fair',  label: '보통',   hint: '과거 평균 근처',
          tilt: { cash: 0, sat: 0 },
          force: {},
          read: '가격이 판단을 도와주지 않는 구간. 이럴 때는 <b>타이밍을 포기하고 적립식으로</b> 넘어가는 게 정답이다.' },
        { v: 'rich',  label: '비싼 편', hint: '지수 PER/PBR이 과거 평균을 크게 상회',
          tilt: { cash: +7, sat: -4 },
          force: {"down": "높은 밸류에이션 — 작은 실망에도 크게 빠진다"},
          read: '나쁜 소식에 취약해진 구간. 새 돈은 <b>한 번에 넣지 말고 기간을 늘려</b> 나눠 넣는다. 이미 가진 건 팔지 않는다.' }
      ]
    },
    {
      key: 'fx', icon: '💱', title: '원/달러 환율은?',
      why: '미국 주식 투자자에게 환율은 두 번째 종목이다. 주가가 그대로여도 환율로 손익이 갈린다.',
      where: [
        { label: '네이버 환율', url: 'https://finance.naver.com/marketindex/', for: 'both' },
        { label: '한국은행 환율 통계', url: 'https://ecos.bok.or.kr/', for: 'both' }
      ],
      options: [
        { v: 'strong', label: '원화 강세', hint: '달러가 싸진 상태',
          tilt: { cash: -2, sat: 0 },
          forceByMarket: {"kr": {"down": "원화 강세 — 수출 기업 실적에는 역풍"}, "us": {"up": "원화 강세 — 달러 자산을 싸게 살 수 있다"}},
          read: '<b>달러 자산을 싸게 사는 구간</b>이다. 미국 적립을 늘리기 좋고, 반대로 수출 기업(국내)의 실적에는 역풍이다.' },
        { v: 'neutral', label: '보통', hint: '최근 1년 범위의 가운데',
          tilt: { cash: 0, sat: 0 },
          forceByMarket: {},
          read: '환율이 판단에 개입하지 않는 구간. 정해둔 환전 규칙대로 진행한다.' },
        { v: 'weak',   label: '원화 약세', hint: '달러가 비싸진 상태',
          tilt: { cash: +3, sat: 0 },
          forceByMarket: {"kr": {"up": "원화 약세 — 수출 기업 실적에는 순풍", "down": "원화 약세 — 외국인 자금이 빠져나갈 압력"}, "us": {"down": "원화 약세 — 지금 환전하면 비싼 달러로 사게 된다"}},
          read: '지금 환전해 미국 주식을 사면 <b>비싼 달러로 사는 것</b>이다. 환전을 여러 번에 나눠서 하는 편이 낫다. 국내 수출주에는 순풍.' }
      ]
    },
    {
      key: 'geo', icon: '🌐', title: '지정학·정책 긴장도는?',
      why: '전쟁·관세·수출규제는 실적보다 먼저, 그리고 더 갑자기 가격을 움직인다.',
      where: [
        { label: '연합뉴스 국제', url: 'https://www.yna.co.kr/international/all', for: 'both' },
        { label: 'VIX (공포지수)', url: 'https://finance.yahoo.com/quote/%5EVIX', for: 'both' }
      ],
      options: [
        { v: 'calm', label: '평온', hint: '큰 헤드라인 없음, VIX 낮음',
          tilt: { cash: -2, sat: +2 },
          force: {"up": "지정학 평온 — 위험자산으로 자금이 돌아온다"},
          read: '평온할 때가 <b>규칙을 정비할 때</b>다. 위기 때 뭘 살지 미리 적어둔다 — 급락장에서는 판단력이 남아 있지 않다.' },
        { v: 'tense', label: '긴장', hint: '관세·수출규제·분쟁 헤드라인 지속',
          tilt: { cash: +5, sat: -4 },
          force: {"down": "지정학 긴장 — 한 나라에 매출이 몰린 기업부터 흔들린다"},
          read: '<b>매출이 한 나라에 몰린 회사</b>부터 흔들린다. 반대로 전 세계에 고르게 파는 필수소비재는 상대적으로 안전하다. 뉴스마다 매매하지 말고 비중만 조절한다.' },
        { v: 'shock', label: '충격 발생', hint: '지수 급락, VIX 급등',
          tilt: { cash: +6, sat: -6 },
          force: {"down": "충격 발생 — 지수와 무관하게 투매가 나오는 구간"},
          read: '가장 중요한 건 <b>아무것도 하지 않는 것</b>이다. 급락 중 매도는 대부분 최악의 선택이었다. 예정된 적립은 그대로 진행하고, 여유가 있으면 나눠서 추가 매수한다.' }
      ]
    }
  ];

  /* ── 국면 라벨 판정 ──────────────────────────────────────────────
     금리 × 경기 조합으로 큰 그림을 먼저 잡고, 밸류에이션/지정학으로
     수식어를 붙인다. 이름이 있어야 초보자가 상황을 기억한다.        */
  function labelRegime(s) {
    var base;
    if (s.growth === 'reces')                         base = { name: '침체 방어', emoji: '🛡️' };
    else if (s.rates === 'hike' && s.growth !== 'expand') base = { name: '긴축 역풍', emoji: '🌬️' };
    else if (s.rates === 'cut'  && s.growth === 'expand') base = { name: '완화 순풍', emoji: '⛵' };
    else if (s.rates === 'cut'  && s.growth === 'slow')   base = { name: '구조 전환', emoji: '🔄' };
    else if (s.growth === 'slow')                     base = { name: '둔화 관망', emoji: '🌫️' };
    else if (s.growth === 'expand')                   base = { name: '확장 지속', emoji: '🌤️' };
    else                                              base = { name: '방향 탐색', emoji: '🧭' };

    var mods = [];
    if (s.valuation === 'rich')  mods.push('고평가');
    if (s.valuation === 'cheap') mods.push('저평가');
    if (s.geo === 'shock')       mods.push('충격 국면');
    else if (s.geo === 'tense')  mods.push('지정학 긴장');
    if (s.fx === 'weak')         mods.push('고환율');

    return {
      emoji: base.emoji,
      name: base.name,
      full: (mods.length ? mods.join('·') + ' ' : '') + base.name
    };
  }

  /* ── 국면별 "이번 달 행동" — 배분보다 이게 실제 결과를 바꾼다 ──── */
  function actions(s, marketKey) {
    var out = [];

    if (s.geo === 'shock') {
      out.push({ icon: '✋', t: '오늘은 아무것도 팔지 않는다',
        d: '급락 중 매도는 손실을 확정하는 행위다. 계좌를 닫고 하루를 넘겨라.' });
    }
    if (s.valuation === 'rich') {
      out.push({ icon: '🪓', t: '이번 달 투자금을 3~4번으로 쪼갠다',
        d: '비싼 구간에서 한 번에 넣으면 첫 조정에 버틸 이유가 사라진다. 주 1회로 나눠 넣어라.' });
    } else if (s.valuation === 'cheap') {
      out.push({ icon: '🧺', t: '예정된 금액은 미루지 않는다',
        d: '싸 보일 때 사람들은 "더 빠질까 봐" 미룬다. 그 미룸이 장기 수익률을 가장 크게 깎는다.' });
    }
    if (s.rates === 'hike') {
      out.push({ icon: '💵', t: '이익이 먼 미래인 종목의 비중을 줄인다',
        d: '적자 성장주·고밸류 위성 종목이 먼저 맞는다. 지금 현금을 버는 회사로 무게를 옮겨라.' });
    }
    if (s.rates === 'cut' && s.growth === 'slow') {
      out.push({ icon: '🔍', t: '"왜 내리는가"를 먼저 확인한다',
        d: '경기가 좋아서 내리는 인하와 나빠서 내리는 인하는 결과가 정반대다. 후자면 방어 업종 비중을 유지한다.' });
    }
    if (s.growth === 'reces') {
      out.push({ icon: '🏠', t: '투자보다 생활비 방어가 먼저',
        d: '실직 위험이 있으면 비상금을 6개월치로 늘린다. 그 다음에야 적립을 논한다.' });
    }
    if (s.geo === 'tense') {
      out.push({ icon: '🌍', t: '매출이 한 나라에 쏠린 종목을 점검한다',
        d: '보유 종목의 국가별 매출 비중을 확인하라. 한 곳에 70% 이상 몰려 있으면 위성 취급을 해야 한다.' });
    }

    if (marketKey === 'us') {
      if (s.fx === 'weak') {
        out.push({ icon: '💱', t: '환전을 여러 번에 나눠서 하기',
          d: '고환율에 전액 환전하면 나중에 환차손이 난다. 환전을 3~4번에 나눠서 하라.' });
      } else if (s.fx === 'strong') {
        out.push({ icon: '🛒', t: '달러가 쌀 때 환전을 조금 더 해둔다',
          d: '지금 사지 않더라도 달러로 바꿔 예수금으로 두면 실탄이 된다.' });
      }
      out.push({ icon: '🧾', t: '연 250만 원 양도소득 공제를 기억한다',
        d: '연말에 이익 실현으로 공제를 채우거나, 손실 종목 정리로 세금을 줄일 수 있다. 안 쓰면 그 해 공제는 사라진다.' });
    } else {
      if (s.fx === 'weak') {
        out.push({ icon: '🚢', t: '고환율은 국내 수출주에 순풍',
          d: '반도체·자동차 등 수출 비중이 큰 종목의 실적에 유리하게 작용한다. 다만 이미 가격에 반영됐을 수 있다.' });
      }
      out.push({ icon: '🏦', t: '같은 종목이라도 계좌를 먼저 고른다',
        d: '배당 비중이 큰 포트폴리오라면 ISA·연금저축에 담을 때 실수령액이 달라진다.' });
    }

    out.push({ icon: '📅', t: '계좌 확인은 월 1회 정해진 날에',
      d: '확인 빈도를 줄이는 것만으로 불필요한 매매가 크게 줄어든다. 알림도 끈다.' });

    return out;
  }

  /* ── 향후 시장 흐름: 구조적 테마 ───────────────────────────────
     "다음 분기에 뭐가 오를까"는 아무도 모른다. 대신 10년 단위로
     방향이 거의 정해진 흐름은 있다. 초보자가 테마주에 뛰어들지 않고
     블루칩으로 그 흐름을 타는 방법을 같이 적는다 — 이게 이 섹션의 목적. */
  var THEMES = [
    { icon: '🤖', title: 'AI 인프라 구축',
      body: 'AI 모델을 돌리려면 칩·서버·데이터센터가 필요하다. 이 투자는 이미 국가·기업 예산에 잡힌 다년 계획이라 한두 분기 뉴스로 뒤집히지 않는다.',
      blue: '초보자가 "AI 테마주"를 쫓는 대신, <b>클라우드를 파는 회사(MSFT·GOOGL)</b>나 <b>메모리(삼성전자·SK하이닉스)</b>처럼 이미 이익을 내는 대형주로 접근하는 편이 안전하다.',
      caution: 'AI 관련주는 기대가 가격에 미리 반영된다. 실적보다 기대가 앞서면 조정 폭이 크다.' },
    { icon: '⚡', title: '전력 부족과 인프라',
      body: '데이터센터·전기차·재생에너지는 모두 전력을 더 쓴다. 발전·송배전·전력기기는 지어지는 데 10년이 걸려 공급이 급히 못 늘어난다.',
      blue: '전력·산업가스·폐기물처럼 <b>규제로 진입이 막힌 인프라 사업(LIN·WM)</b>이 이 흐름의 조용한 수혜자다.',
      caution: '유틸리티는 금리에 민감하다. 금리가 오르는 국면에서는 좋은 사업이어도 주가가 눌린다.' },
    { icon: '🧬', title: '고령화와 헬스케어',
      body: '한국·일본·유럽·중국이 동시에 늙는다. 되돌릴 수 없는 인구 구조라 의약품·의료기기 수요는 가장 예측 가능한 장기 흐름이다.',
      blue: '신약 성공 여부에 베팅하는 대신 <b>대형 제약(JNJ)</b>이나 <b>위탁생산(삼성바이오로직스)</b>처럼 성공/실패와 무관하게 돈을 버는 구조를 본다.',
      caution: '약가 인하는 세계 모든 정부의 단골 정책이다. 정치 일정에 따라 업종 전체가 눌릴 수 있다.' },
    { icon: '🛡️', title: '공급망 재편과 방산',
      body: '효율(가장 싼 곳에서 생산)에서 안전(우방국에서 생산)으로 기준이 바뀌었다. 반도체·배터리 공장의 위치가 정치로 결정되고, 국방예산은 구조적으로 늘었다.',
      blue: '방산은 수요의 원천이 긴장이라 <b>위성 비중으로만</b> 다룬다. 오히려 <b>생산기지를 여러 나라에 가진 대형주</b>가 이 흐름에서 덜 다친다.',
      caution: '지정학 뉴스에 급등한 뒤 사면 대부분 고점이다. 이 테마만큼은 뉴스와 매수 시점을 반드시 떼어놔야 한다.' },
    { icon: '💳', title: '현금 없는 사회',
      body: '전 세계에서 현금 결제가 줄고 디지털 결제로 넘어가는 흐름은 수십 년째 한 방향이다.',
      blue: '<b>결제망(V)</b>은 경기와 무관하게 거래 건수에서 수수료를 받는다. 인플레이션이 오면 결제 금액이 커져 수수료도 커진다.',
      caution: '각국 정부가 수수료를 규제하려 한다. 계좌 간 즉시이체가 카드망을 우회하는 것도 장기 위협이다.' },
    { icon: '🏛️', title: '주주환원 강화 (국내)',
      body: '한국 증시의 저평가를 풀기 위한 배당·자사주 소각 확대 흐름. 세제와 지수 편입 기준이 이 방향을 밀고 있다.',
      blue: '<b>금융지주·보험·통신·지주회사</b>가 직접 수혜 위치다. 이미 현금을 벌고 있는데 안 나눠주던 회사들이 대상이다.',
      caution: '정책은 정권과 함께 바뀔 수 있다. 정책 기대만으로 산 종목은 정책이 식으면 같이 식는다.' }
  ];

  /* ── 기본 스냅샷 ────────────────────────────────────────────────
     사람이 마지막으로 확인한 값. 여기 손대면 asOf도 반드시 고칠 것.
     UI가 asOf 경과일을 계산해 "며칠 지난 값"이라고 크게 알려준다.   */
  var DEFAULTS = {
    /* 비상 출발값 — live.json 의 regime 을 못 읽었을 때만 쓰인다.
       평소에는 이 값이 화면에 보이지 않는 게 정상이다. */
    asOf: '2026-05-31',
    kr: { rates: 'hold', growth: 'slow',   valuation: 'cheap', fx: 'weak',    geo: 'tense' },
    us: { rates: 'hold', growth: 'expand', valuation: 'rich',  fx: 'weak',    geo: 'tense' },
    note: '이 값은 자동 판정을 못 받아왔을 때만 쓰이는 출발점입니다. ' +
          '<b>정세는 하루 만에 뒤집힙니다.</b> 위 링크로 직접 확인하고 다르다고 생각되면 바꾸세요.'
  };

  return {
    dials: DIALS,
    themes: THEMES,
    defaults: DEFAULTS,
    labelRegime: labelRegime,
    actions: actions,

    /* 국면 판정 → 배분 조정치(%p) 합산. 극단으로 튀지 않게 상·하한을 둔다. */
    tilt: function (state) {
      var cash = 0, sat = 0;
      DIALS.forEach(function (d) {
        var opt = null;
        d.options.forEach(function (o) { if (o.v === state[d.key]) opt = o; });
        if (opt) { cash += opt.tilt.cash; sat += opt.tilt.sat; }
      });
      return {
        cash: Math.max(-12, Math.min(24, cash)),
        sat:  Math.max(-14, Math.min(8,  sat))
      };
    },

    /* ▲ 밀어올리는 힘 / ▼ 눌러내리는 힘.
       국면 판정에서 "지금 시장이 왜 오르고 왜 내리는지"를 도출한다.
       홈에서는 뺐고(효용이 낮았다), 시장 탭의 해설에만 남겼다. */
    forces: function (state, marketKey) {
      var up = [], down = [];
      DIALS.forEach(function (d) {
        d.options.forEach(function (o) {
          if (o.v !== state[d.key]) return;
          var f = o.forceByMarket ? o.forceByMarket[marketKey] : o.force;
          if (!f) return;
          if (f.up) up.push({ icon: d.icon, text: f.up });
          if (f.down) down.push({ icon: d.icon, text: f.down });
        });
      });
      return { up: up, down: down };
    },

    /* 각 판정의 해설 문장 모음 — 수치 근거(judge-regime.mjs 의 why)와 달리
       "그래서 무엇을 해야 하나"를 말한다. 둘 다 필요하다. */
    readings: function (state) {
      var out = [];
      DIALS.forEach(function (d) {
        d.options.forEach(function (o) {
          if (o.v === state[d.key]) {
            out.push({ icon: d.icon, title: d.title, choice: o.label, read: o.read });
          }
        });
      });
      return out;
    }
  };
})();
