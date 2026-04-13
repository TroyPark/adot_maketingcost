/**
 * (레거시) 대분류 → 팀 id 기본 매핑. 현재 user/abp는 Firestore
 * `inquiryCategoryDefinitions`를 단일 소스로 사용합니다.
 * 이 파일은 다른 스크립트에서 참조하지 않을 수 있습니다.
 */
(function (global) {
    'use strict';

    const DEFAULT_MAJOR_TO_TEAM_ROUTING = Object.freeze({
        marketing: 'biz_mk2',
        special_lecture_briefing: 'biz_plan',
        settlement_purchase_cost_facility: 'sales_ops',
        seminar_education_instructor: 'hrd_academy',
        content_mock_exam_fast_grading: 'eng_lab',
        lecture_youtube: 'content_prod',
        bug_feature_ai: 'it_dev',
        hr_admin: 'corp_admin',
        unset: 'biz_mk1'
    });

    var majorToTeamOverride = null;

    function getEffectiveMajorToTeamRouting() {
        if (!majorToTeamOverride || typeof majorToTeamOverride !== 'object') {
            return DEFAULT_MAJOR_TO_TEAM_ROUTING;
        }
        return Object.assign({}, DEFAULT_MAJOR_TO_TEAM_ROUTING, majorToTeamOverride);
    }

    /**
     * @param {Record<string, string>|null} partial - 대분류 id → 팀 id. null이면 코드 기본값만 사용.
     */
    function setMajorToTeamRoutingOverride(partial) {
        majorToTeamOverride = partial && typeof partial === 'object' ? Object.assign({}, partial) : null;
    }

    function resolveAbpTargetTeamFromCategory(majorId, minorId) {
        if (majorId === 'manual_team') return minorId || null;
        var routing = getEffectiveMajorToTeamRouting();
        return routing[majorId] != null ? routing[majorId] : null;
    }

    global.AbpInquiryRouting = {
        DEFAULT_MAJOR_TO_TEAM_ROUTING: DEFAULT_MAJOR_TO_TEAM_ROUTING,
        getEffectiveMajorToTeamRouting: getEffectiveMajorToTeamRouting,
        setMajorToTeamRoutingOverride: setMajorToTeamRoutingOverride,
        resolveAbpTargetTeamFromCategory: resolveAbpTargetTeamFromCategory
    };
})(typeof window !== 'undefined' ? window : typeof global !== 'undefined' ? global : this);
