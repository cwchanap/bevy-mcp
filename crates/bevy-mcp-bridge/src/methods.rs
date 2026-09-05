use std::collections::HashMap;

use bevy_ecs::{component::ComponentId, resource::IsResource, system::In, world::World};
use bevy_remote::{BrpError, BrpResult, error_codes::INVALID_PARAMS};
use bevy_time::{Time, Virtual};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_STATS_LIMIT: usize = 500;
pub const DEFAULT_STATS_LIMIT: usize = 50;

#[derive(Deserialize, JsonSchema)]
pub struct WorldStatsParams {
    pub limit: Option<usize>,
}

#[derive(Serialize, JsonSchema, Debug, PartialEq, Eq)]
pub struct ComponentCount {
    pub name: String,
    pub entities: usize,
}

#[derive(Serialize, JsonSchema, Debug, PartialEq, Eq)]
pub struct WorldStatsResult {
    pub entities: u32,
    pub archetypes: usize,
    pub components: Vec<ComponentCount>,
    pub returned: usize,
    pub truncated: bool,
}

pub fn validate_stats_limit(limit: usize) -> Result<usize, String> {
    if limit == 0 {
        return Err("limit must be greater than 0".to_string());
    }
    if limit > MAX_STATS_LIMIT {
        return Err(format!("limit must not exceed {MAX_STATS_LIMIT}"));
    }
    Ok(limit)
}

pub fn collect_world_stats(world: &World, limit: usize) -> Result<WorldStatsResult, String> {
    let limit = validate_stats_limit(limit)?;

    let is_resource_id: Option<ComponentId> = world.components().component_id::<IsResource>();
    let mut totals: HashMap<ComponentId, usize> = HashMap::new();
    let mut entities = 0u32;
    let mut archetypes = 0usize;
    for archetype in world.archetypes().iter().filter(|a| !a.is_empty()) {
        let comps = archetype.components();
        if is_resource_id.is_some_and(|id| comps.contains(&id)) {
            continue;
        }
        entities += archetype.len();
        archetypes += 1;
        for id in comps {
            *totals.entry(*id).or_default() += archetype.len() as usize;
        }
    }

    let mut components: Vec<ComponentCount> = totals
        .into_iter()
        .map(|(id, count)| ComponentCount {
            name: world
                .components()
                .get_name(id)
                .map(|name| name.to_string())
                .unwrap_or_else(|| format!("{id:?}")),
            entities: count,
        })
        .collect();
    components.sort_by(|a, b| b.entities.cmp(&a.entities).then(a.name.cmp(&b.name)));

    let truncated = components.len() > limit;
    components.truncate(limit);

    Ok(WorldStatsResult {
        entities,
        archetypes,
        returned: components.len(),
        truncated,
        components,
    })
}

#[derive(Deserialize, JsonSchema)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum TimeControlParams {
    Pause,
    Resume,
    SetScale { scale: f32 },
}

#[derive(Serialize, JsonSchema, Debug, PartialEq)]
pub struct TimeControlResult {
    pub paused: bool,
    pub relative_speed: f32,
}

pub fn apply_time_control(
    time: &mut Time<Virtual>,
    params: TimeControlParams,
) -> Result<TimeControlResult, String> {
    match params {
        TimeControlParams::Pause => time.pause(),
        TimeControlParams::Resume => time.unpause(),
        TimeControlParams::SetScale { scale } => {
            if !scale.is_finite() || scale <= 0.0 {
                return Err(format!(
                    "scale must be a finite number greater than 0, got {scale}"
                ));
            }
            time.set_relative_speed(scale);
        }
    }
    Ok(TimeControlResult {
        paused: time.is_paused(),
        relative_speed: time.relative_speed(),
    })
}

pub fn world_stats(In(params): In<Option<Value>>, world: &mut World) -> BrpResult {
    let params: WorldStatsParams = match params {
        Some(value) => serde_json::from_value(value).map_err(invalid_params)?,
        None => WorldStatsParams { limit: None },
    };
    let limit = params.limit.unwrap_or(DEFAULT_STATS_LIMIT);

    let result = collect_world_stats(world, limit).map_err(invalid_params)?;
    serialize_result(&result)
}

pub fn time_control(In(params): In<Option<Value>>, world: &mut World) -> BrpResult {
    let params: TimeControlParams = parse_params(params)?;
    let mut time = world
        .get_resource_mut::<Time<Virtual>>()
        .ok_or_else(|| BrpError::internal("Time<Virtual> resource not found"))?;

    let result = apply_time_control(&mut time, params).map_err(invalid_params)?;
    serialize_result(&result)
}

fn parse_params<T: for<'de> Deserialize<'de>>(params: Option<Value>) -> Result<T, BrpError> {
    let params = params.ok_or_else(|| invalid_params("missing parameters"))?;
    serde_json::from_value(params).map_err(invalid_params)
}

fn serialize_result<T: Serialize>(result: &T) -> BrpResult {
    serde_json::to_value(result)
        .map_err(|error| BrpError::internal(format!("failed to serialize result: {error}")))
}

fn invalid_params(error: impl ToString) -> BrpError {
    BrpError {
        code: INVALID_PARAMS,
        message: error.to_string(),
        data: None,
    }
}
