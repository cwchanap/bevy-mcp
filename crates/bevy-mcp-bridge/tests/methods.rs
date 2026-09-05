use bevy_ecs::{component::Component, world::World};
use bevy_mcp_bridge::methods::{TimeControlParams, apply_time_control, collect_world_stats};
use bevy_time::{Time, Virtual};

#[derive(Component)]
struct Alpha;

#[derive(Component)]
struct Beta;

#[derive(Component)]
struct Gamma;

#[test]
fn world_stats_bounded_counts_and_truncation() {
    let mut world = World::new();
    world.spawn((Alpha,));
    world.spawn((Alpha, Beta));

    let result = collect_world_stats(&world, 1).unwrap();
    assert_eq!(result.entities, 2);
    assert_eq!(result.components.len(), 1);
    assert_eq!(result.components[0].entities, 2);
    assert_eq!(result.returned, 1);
    assert!(result.truncated);
}

#[test]
fn world_stats_orders_count_desc_then_name_asc() {
    let mut world = World::new();
    for _ in 0..3 {
        world.spawn((Alpha,));
    }
    for _ in 0..2 {
        world.spawn((Beta,));
    }
    for _ in 0..2 {
        world.spawn((Gamma,));
    }

    let result = collect_world_stats(&world, 500).unwrap();
    let names: Vec<&str> = result.components.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(
        names,
        vec!["methods::Alpha", "methods::Beta", "methods::Gamma"]
    );
    assert_eq!(result.components[0].entities, 3);
    assert_eq!(result.components[1].entities, 2);
    assert_eq!(result.components[2].entities, 2);
    assert_eq!(result.returned, 3);
    assert!(!result.truncated);
}

#[test]
fn world_stats_rejects_zero_limit() {
    let world = World::new();
    assert!(collect_world_stats(&world, 0).is_err());
}

#[test]
fn world_stats_rejects_limit_over_500() {
    let world = World::new();
    assert!(collect_world_stats(&world, 501).is_err());
}

#[test]
fn time_control_pause_resume_and_scale() {
    let mut time = Time::<Virtual>::default();

    apply_time_control(&mut time, TimeControlParams::Pause).unwrap();
    assert!(time.is_paused());

    apply_time_control(&mut time, TimeControlParams::Resume).unwrap();
    assert!(!time.is_paused());

    let result = apply_time_control(&mut time, TimeControlParams::SetScale { scale: 2.0 }).unwrap();
    assert_eq!(time.relative_speed(), 2.0);
    assert!(!result.paused);
    assert_eq!(result.relative_speed, 2.0);
}

#[test]
fn time_control_rejects_invalid_scales() {
    let mut time = Time::<Virtual>::default();
    for scale in [0.0, -1.0, f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
        assert!(
            apply_time_control(&mut time, TimeControlParams::SetScale { scale }).is_err(),
            "scale {scale} should be rejected"
        );
    }
}
